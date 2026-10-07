// Reads the wave ROM through one of the two SysEx routes, into a RomImage. The caller passes a `send` function and
// feeds every incoming SysEx message to `feed()`; progress comes back through callbacks.
//
// Neither route puts an address in its replies, so the data is counted. To keep a lost reply from shifting every
// dword after it, the ROM is read in chunks: each chunk starts by setting the address again, and it is accepted only
// when every reply arrived, in order and intact. A chunk that does not is read again from its start. Inside a chunk,
// a few requests are kept in flight so that the synth's MIDI Out never waits for the host.
//
// When the synth stops answering for a while, the chunk is read again, but the replies to the earlier tries may still
// arrive late. So every try starts by reading a register, a different one for each try of a chunk. The reply names
// the register it answers, and the synth answers in order, so every data reply before that one belongs to an earlier
// try and is dropped. A chunk has at most one try per marker register, so a late reply from an earlier try of the same
// chunk is never taken for the current one; earlier chunks have no replies left, because a chunk is accepted only
// after all of its replies. Both routes use the register messages for this; the MU2000 has them too.

import {
	WAVE_BLOCK_DWORDS, SWP_REGISTER, buildPositionMessage, buildWaveBlockRequest, parseWaveBlockReply,
	buildFifoStart, buildFifoStop, buildRegisterRead, parseRegisterReply, buildMarkerRead, MARKER_COUNT,
} from './sysex.js';

const MAX_CHUNK_RETRIES = MARKER_COUNT - 1;

class ChunkDumper {
	constructor({send, device, image, startDword, dwordCount, onProgress, onLog, onFinish, timeoutMs, chunkDwords, inFlight}) {
		this.send = send;
		this.device = device;
		this.image = image;
		this.startDword = startDword;
		this.endDword = startDword + dwordCount;
		this.onProgress = onProgress;
		this.onLog = onLog;
		this.onFinish = onFinish;
		this.timeoutMs = timeoutMs;
		this.chunkDwords = chunkDwords;
		this.inFlight = inFlight;
		this.stopMessage = null;	// what to send when stopping, if anything

		this.nextDword = startDword;	// where the next chunk starts
		this.retryCount = 0;			// of the current chunk
		this.totalRetries = 0;
		this.badReplies = 0;
		this.lateReplies = 0;	// replies to an earlier try that arrived after it was given up
		this.lastReplyAt = 0;	// when the last message from the synth reached the PC
		this.timedOutAt = null;	// when the last timeout fired
		this.isRunning = false;
		this.isDone = false;
		this.timer = null;
	}

	start() {
		this.isRunning = true;
		this.startChunk();
	}

	stop(reason = 'stopped') {
		if (!this.isRunning) {
			return;
		}
		this.isRunning = false;
		clearTimeout(this.timer);
		this.timer = null;
		if (this.stopMessage) {
			this.send(this.stopMessage);
		}
		this.onFinish?.(reason);
	}

	startChunk() {
		const size = Math.min(this.chunkDwords, this.endDword - this.nextDword);
		if (size <= 0) {
			this.isDone = true;
			this.stop('done');
			return;
		}
		const markerNo = this.retryCount;	// 0 for the first try of a chunk, then 1, 2, ...
		this.chunk = {dword: this.nextDword, size, bytes: new Uint8Array(size * 4), isSynced: false, markerNo};
		this.send(buildMarkerRead(markerNo, this.device));
		this.beginChunk(this.chunk);
		this.armTimer();
	}

	armTimer() {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.handleTimeout(), this.timeoutMs);
	}

	handleTimeout() {
		if (!this.isRunning) {
			return;
		}
		this.timedOutAt = performance.now();
		this.onLog?.(`no reply for ${this.timeoutMs} ms in the chunk at ${formatDwordAddr(this.chunk.dword)}`);
		this.retryChunk();
	}

	retryChunk() {
		this.retryCount++;
		this.totalRetries++;
		if (this.retryCount > MAX_CHUNK_RETRIES) {
			this.stop(`the chunk at ${formatDwordAddr(this.chunk.dword)} failed ${MAX_CHUNK_RETRIES} times in a row`);
			return;
		}
		this.onLog?.(`reading the chunk at ${formatDwordAddr(this.chunk.dword)} again (try ${this.retryCount + 1})`);
		this.startChunk();
	}

	// Called by the route when every reply of the chunk is in and good.
	acceptChunk() {
		const {chunk} = this;
		this.image.putBlock(chunk.dword, chunk.bytes);
		this.nextDword += chunk.size;
		this.retryCount = 0;
		this.onProgress?.();
		this.startChunk();
	}

	// Logs the first late reply of a try: when it reached the PC, against the previous reply and the timeout. A reply
	// that reached the PC before the timeout fired was late only because the browser was busy; one that reached it
	// after was late on the synth's side (or the MIDI interface's).
	logLateReply(receivedAt, prevAt) {
		if (this.chunk.isLateLogged || this.timedOutAt === null) {
			return;
		}
		this.chunk.isLateLogged = true;
		const sinceTimeout = Math.round(receivedAt - this.timedOutAt);
		const where = (sinceTimeout < 0)
			? `${-sinceTimeout} ms before the timeout fired: the browser was busy`
			: `${sinceTimeout} ms after the timeout fired: the synth or the MIDI interface was late`;
		this.onLog?.(`a late reply was dropped. It reached the PC ${Math.round(receivedAt - prevAt)} ms after the previous message from the synth, ${where}`);
	}

	// Every SysEx message from the synth comes here, with the time it reached the PC (`event.timeStamp` of Web MIDI).
	feed(message, receivedAt = performance.now()) {
		if (!this.isRunning) {
			return;
		}
		const prevAt = this.lastReplyAt;
		this.lastReplyAt = receivedAt;
		if (!this.chunk.isSynced) {
			const reply = parseRegisterReply(message);
			if (reply && reply.markerNo === this.chunk.markerNo) {
				this.chunk.isSynced = true;
			} else if (reply?.register || parseWaveBlockReply(message)) {
				this.lateReplies++;
				this.logLateReply(receivedAt, prevAt);
			}
			return;
		}
		this.handleReply(message);
	}
}

// ---- the sampling route (MU2000): 64 bytes per request
export class WaveDumper extends ChunkDumper {
	constructor(options) {
		super({timeoutMs: 1500, chunkDwords: 256 * WAVE_BLOCK_DWORDS, inFlight: 2, ...options});
		console.assert(this.startDword % WAVE_BLOCK_DWORDS === 0 && this.endDword % WAVE_BLOCK_DWORDS === 0);
	}

	beginChunk(chunk) {
		chunk.requested = 0;
		chunk.received = 0;
		chunk.isBad = false;
		this.send(buildPositionMessage(chunk.dword, this.device));
		this.fillRequests();
	}

	fillRequests() {
		const {chunk} = this;
		const blocks = chunk.size / WAVE_BLOCK_DWORDS;
		while (chunk.requested < blocks && chunk.requested - chunk.received < this.inFlight) {
			this.send(buildWaveBlockRequest(this.device));
			chunk.requested++;
		}
	}

	handleReply(message) {
		const reply = parseWaveBlockReply(message);
		if (!reply) {
			return;
		}
		const {chunk} = this;
		const blocks = chunk.size / WAVE_BLOCK_DWORDS;
		if (chunk.received >= blocks) {
			this.onLog?.('an unexpected wave block reply arrived - ignored');
			return;
		}
		if (reply.isOk) {
			chunk.bytes.set(reply.bytes, chunk.received * 64);
		} else {
			this.badReplies++;
			chunk.isBad = true;
			this.onLog?.(`bad checksum in the reply for ${formatDwordAddr(chunk.dword + chunk.received * WAVE_BLOCK_DWORDS)}`);
		}
		chunk.received++;
		if (chunk.received < blocks) {
			this.fillRequests();
			this.armTimer();
		} else if (chunk.isBad) {
			// A reply with a bad checksum may also be one that was lost and replaced by the next, so the whole chunk goes again.
			this.retryChunk();
		} else {
			this.acceptChunk();
		}
	}
}

// ---- the register route (MU1000, MU2000): two passes per chunk
// Pass A starts the FIFO at the chunk's address and reads high, low, high, low, ... Because the firmware reads each
// register twice, this gives hi(D[a + 2k]) and lo(D[a + 2k + 1]). Pass B starts one dword earlier and gives the other
// halves: lo(D[a + 2k]) and hi(D[a + 2k + 1]); it reads one dword more, so that the high half of the chunk's last
// dword is included. Dword 0 has nothing before it, so pass B of the first chunk starts one dword later instead, and
// the low half of dword 0 is filled in from its known value.
const DWORD0_LOW = 0xdfea;

export class RegisterDumper extends ChunkDumper {
	constructor(options) {
		super({timeoutMs: 1500, chunkDwords: 256, inFlight: 4, ...options});
		console.assert(this.chunkDwords % 2 === 0);
		this.stopMessage = buildFifoStop(this.device);
	}

	beginChunk(chunk) {
		chunk.passNo = 0;
		this.beginPass();
	}

	beginPass() {
		const {chunk} = this;
		// Pass A reads from the chunk's address; pass B from one before it (or one after, at address 0).
		const first = (chunk.passNo === 0) ? chunk.dword : ((chunk.dword === 0) ? 1 : chunk.dword - 1);
		const count = chunk.size + chunk.passNo;
		chunk.pass = {first, count, requested: 0, received: 0, isBad: false, isStatusRead: false};
		this.send(buildFifoStart(first, count, this.device));
		this.fillRequests();
	}

	fillRequests() {
		const {chunk} = this;
		const {pass} = chunk;
		while (pass.requested < pass.count && pass.requested - pass.received < this.inFlight) {
			this.send(buildRegisterRead((pass.requested % 2 === 0) ? SWP_REGISTER.DATA_HIGH : SWP_REGISTER.DATA_LOW, this.device));
			pass.requested++;
		}
		// After the last data request, the status tells whether the FIFO was read to its end.
		if (pass.requested === pass.count && !pass.isStatusRead) {
			pass.isStatusRead = true;
			this.send(buildRegisterRead(SWP_REGISTER.STATUS, this.device));
		}
	}

	handleReply(message) {
		const reply = parseRegisterReply(message);
		if (!reply?.register) {
			return;
		}
		const {chunk} = this;
		const {pass} = chunk;
		if (reply.register === SWP_REGISTER.STATUS) {
			// Every low read pops 2 dwords and a high read none, so pass B leaves its extra dword in the FIFO. The low byte
			// of the status is a bitmap of the 8 FIFO slots that still hold data.
			const expectedStatus = 0x4000 | ((chunk.passNo === 0) ? 0 : (1 << (chunk.size % 8)));
			this.finishPass(pass.received === pass.count && !pass.isBad && (reply.value & 0x40ff) === expectedStatus);
			return;
		}
		if (pass.received >= pass.count) {
			this.onLog?.('an unexpected data reply arrived - ignored');
			return;
		}
		const isHighExpected = (pass.received % 2 === 0);
		if (!reply.isOk || (reply.register === SWP_REGISTER.DATA_HIGH) !== isHighExpected) {
			// Out of step: a reply was lost or broken. The pass fails when its status arrives.
			this.badReplies++;
			pass.isBad = true;
		} else {
			this.storeHalf(pass.first + pass.received, isHighExpected, reply.value);
		}
		pass.received++;
		this.fillRequests();
		this.armTimer();
	}

	// Puts one 16-bit half into the chunk's bytes (little-endian dwords), if it belongs to the chunk.
	storeHalf(dwordAddr, isHigh, value) {
		const {chunk} = this;
		const index = dwordAddr - chunk.dword;
		if (index < 0 || index >= chunk.size) {
			return;
		}
		chunk.bytes[index * 4 + ((isHigh) ? 2 : 0)] = value & 0xff;
		chunk.bytes[index * 4 + ((isHigh) ? 3 : 1)] = value >> 8;
	}

	finishPass(isOk) {
		const {chunk} = this;
		this.send(buildFifoStop(this.device));
		if (!isOk) {
			this.onLog?.(`pass ${chunk.passNo + 1} of the chunk at ${formatDwordAddr(chunk.dword)} came back incomplete`);
			this.retryChunk();
			return;
		}
		chunk.passNo++;
		if (chunk.passNo < 2) {
			this.beginPass();
			this.armTimer();
			return;
		}
		if (chunk.dword === 0) {
			chunk.bytes[0] = DWORD0_LOW & 0xff;
			chunk.bytes[1] = DWORD0_LOW >> 8;
			this.onLog?.('the low half of dword 0 cannot be read on this route; its known value was used');
		}
		this.acceptChunk();
	}
}

// Dword addresses are shown as byte offsets, which is what a ROM image file uses.
export function formatDwordAddr(dwordAddr) {
	return `${(dwordAddr * 4).toString(16).toUpperCase().padStart(7, '0')}H`;
}
