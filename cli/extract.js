#!/usr/bin/env node
/*
	Write out the wave ROM files from the WAV files that the MU2000 saved to the card.

	  node cli/extract.js WAVEROM.WAV [-d outdir] [-n]
	  node cli/extract.js WAVEROM1.WAV WAVEROM2.WAV WAVEROM3.WAV WAVEROM4.WAV [-d outdir] [-n]

	A WAV holds the wave ROM as it is, in little-endian dwords: the whole 32 MiB, or one or more 8 MiB parts. Where each
	part belongs is found from the words the firmware's test mode checks, so the files can be given in any order.
*/

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';
import util from 'node:util';

import {RomImage, ROM_DWORDS, ROM_FILES, PAIR_COUNT, PAIR_DWORDS, KNOWN_DWORDS, makeFileName} from '../lib/rom_image.js';

const MODEL_NAME = 'mu2000';	// only the MU2000 can point a sample at the wave ROM

const PART_DWORDS = ROM_DWORDS / 4;	// 8 MiB: the smallest piece a WAV holds
const PART_COUNT  = ROM_DWORDS / PART_DWORDS;

// ---- reading a WAV
// The data of a WAV file of 16-bit mono PCM, or an error text.
export function readWavData(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const readId = (pos) => String.fromCharCode(...bytes.subarray(pos, pos + 4));
	if (bytes.length < 12 || readId(0) !== 'RIFF' || readId(8) !== 'WAVE') {
		return {error: 'not a WAV file'};
	}
	let fmt = null;
	for (let pos = 12; pos + 8 <= bytes.length;) {
		const id = readId(pos);
		const size = view.getUint32(pos + 4, true);
		if (id === 'fmt ') {
			fmt = {format: view.getUint16(pos + 8, true), channels: view.getUint16(pos + 10, true), bits: view.getUint16(pos + 22, true)};
		} else if (id === 'data') {
			if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16) {
				return {error: 'not 16-bit mono PCM: the sample was not set up by the files in card/'};
			}
			if (pos + 8 + size > bytes.length) {
				return {error: `the data is cut short: ${bytes.length - pos - 8} of ${size} bytes`};
			}
			return {data: bytes.subarray(pos + 8, pos + 8 + size)};
		}
		pos += 8 + size + (size & 1);
	}
	return {error: 'no data in the WAV file'};
}

// ---- placing the data
// The dword at which `data` starts: the part boundary where every known word inside it matches, or null.
function findStartDword(data) {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const dwordCount = data.length / 4;
	for (let startDword = 0; startDword + dwordCount <= ROM_DWORDS; startDword += PART_DWORDS) {
		const inside = KNOWN_DWORDS.filter(([addr]) => (addr >= startDword && addr < startDword + dwordCount));
		if (inside.length && inside.every(([addr, value]) => (view.getUint32((addr - startDword) * 4, true) === value))) {
			return startDword;
		}
	}
	return null;
}

// Puts the data of the WAV files into the image: {parts: Map(partNo -> {data, name}), problems: [text]}. Each WAV must
// be whole 8 MiB parts. A part given twice with different contents is not kept.
export function placeWavs(wavs) {
	const parts = new Map();
	const conflictNos = new Set();
	const problems = [];
	for (const {name, data} of wavs) {
		if (data.length === 0 || data.length % (PART_DWORDS * 4)) {
			problems.push(`${name}: ${data.length} bytes, not a multiple of 8 MiB`);
			continue;
		}
		const startDword = findStartDword(data);
		if (startDword === null) {
			problems.push(`${name}: the known words of the wave ROM are not in it`);
			continue;
		}
		for (let offset = 0; offset < data.length; offset += PART_DWORDS * 4) {
			const partNo = (startDword * 4 + offset) / (PART_DWORDS * 4);
			const partData = data.subarray(offset, offset + PART_DWORDS * 4);
			const oldPart = parts.get(partNo);
			if (oldPart && Buffer.compare(oldPart.data, partData) !== 0) {
				problems.push(`${formatPart(partNo)}: ${oldPart.name} and ${name} differ`);
				conflictNos.add(partNo);
			} else if (!oldPart) {
				parts.set(partNo, {data: partData, name});
			}
		}
	}
	for (const partNo of conflictNos) {
		parts.delete(partNo);
	}
	return {parts, problems};
}

// A pair is complete when both of its parts are there. They go into the image in order.
export function buildImage(parts) {
	const image = new RomImage();
	const completePairNos = [];
	const partsPerPair = PART_COUNT / PAIR_COUNT;
	for (let pairNo = 0; pairNo < PAIR_COUNT; pairNo++) {
		const partNos = Array.from({length: partsPerPair}, (_, i) => (pairNo * partsPerPair + i));
		if (!partNos.every((partNo) => parts.has(partNo))) {
			continue;
		}
		for (const partNo of partNos) {
			image.putBlock(partNo * PART_DWORDS, parts.get(partNo).data);
		}
		completePairNos.push(pairNo);
	}
	return {image, completePairNos};
}

const toHex = (value, width) => value.toString(16).toUpperCase().padStart(width, '0');

// "0000000H-07FFFFFH": the byte offsets in the image.
function formatPart(partNo) {
	return `${toHex(partNo * PART_DWORDS * 4, 7)}H-${toHex((partNo + 1) * PART_DWORDS * 4 - 1, 7)}H`;
}

// ---- the command
function printUsageAndExit(message) {
	if (message) {
		process.stderr.write(`extract: ${message}\n\n`);
	}
	process.stderr.write('usage: node cli/extract.js <wav> [more...] [-d outdir] [-n]\n' +
		'  the WAV files that the synth saved from the samples set up by the files in card/\n' +
		'  -d, --dir     where to write the files (default: .)\n' +
		'  -n, --dry-run check the WAV files, write nothing\n');
	process.exit((message) ? 2 : 0);
}

function main() {
	// Read the command-line arguments.
	let values, inputs;
	try {
		({values, positionals: inputs} = util.parseArgs({
			args: process.argv.slice(2),
			options: {
				'help': {type: 'boolean', short: 'h'},
				'dir': {type: 'string', short: 'd', default: '.'},
				'dry-run': {type: 'boolean', short: 'n', default: false},
			},
			allowPositionals: true,
		}));
	} catch (e) {
		printUsageAndExit(e.message);
	}
	if (values.help) {
		printUsageAndExit();
	}
	const {dir} = values;
	const isDryRun = values['dry-run'];
	if (!inputs.length) {
		printUsageAndExit('no input file');
	}

	// Read every WAV file.
	const wavs = [];
	for (const input of inputs) {
		let bytes;
		try {
			bytes = new Uint8Array(fs.readFileSync(input));
		} catch (e) {
			printUsageAndExit(`cannot read ${input}: ${e.message}`);
		}
		const name = path.basename(input);
		const {data, error} = readWavData(bytes);
		if (error) {
			process.stderr.write(`${name}: ${error}\n`);
			continue;
		}
		wavs.push({name, data});
	}

	// Place the parts, and say where each one went.
	const {parts, problems} = placeWavs(wavs);
	for (const problem of problems) {
		process.stderr.write(`${problem}\n`);
	}
	process.stderr.write('\n');
	for (let partNo = 0; partNo < PART_COUNT; partNo++) {
		process.stderr.write(`  ${formatPart(partNo)}  ${parts.get(partNo)?.name ?? 'MISSING'}\n`);
	}

	// Put the complete pairs together, and check them.
	const {image, completePairNos} = buildImage(parts);
	const check = image.checkKnownWords();
	for (const {addr, expected, actual} of check.mismatched) {
		process.stderr.write(`\nthe word at H'${toHex(addr * 4, 7)} should be ${toHex(expected, 8)}, but is ${toHex(actual, 8)}\n`);
	}
	const isCheckOk = (check.mismatched.length === 0);

	// Print the summary table.
	process.stderr.write(`\n  ${'file'.padEnd(26)} ${'size'.padStart(8)}  status\n`);
	for (const [fileNo, file] of ROM_FILES.entries()) {
		let status = 'INCOMPLETE';
		if (completePairNos.includes(file.pairNo)) {
			status = (isCheckOk) ? `complete, CRC32 ${toHex(image.calcFileCrc32(fileNo), 8)}` : 'complete, but the known words differ';
		}
		process.stderr.write(`  ${makeFileName(MODEL_NAME, fileNo).padEnd(26)} ${String(PAIR_DWORDS * 2).padStart(8)}  ${status}\n`);
	}

	// Write the files of the complete pairs.
	if (!isDryRun && isCheckOk && completePairNos.length) {
		fs.mkdirSync(dir, {recursive: true});
		process.stderr.write('\n');
		for (const [fileNo, file] of ROM_FILES.entries()) {
			if (!completePairNos.includes(file.pairNo)) {
				continue;
			}
			const name = makeFileName(MODEL_NAME, fileNo);
			fs.writeFileSync(path.join(dir, name), image.getFileBytes(fileNo));
			process.stderr.write(`wrote ${path.join(dir, name)}\n`);
		}
	}

	process.exit((completePairNos.length < PAIR_COUNT || !isCheckOk || problems.length) ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
	main();
}
