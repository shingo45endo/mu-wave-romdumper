// What the two pages share: Web MIDI port selection, the log, the modals, saving a file, and the table of the 4 ROM
// files with their progress. Both pages use the same element ids.

import {ROM_FILES, PAIR_COUNT, FILE_SIZE, ROM_DWORDS, makeFileName} from '../lib/rom_image.js';

export function logLine(text) {
	const elemLog = document.getElementById('my-log');
	elemLog.append(`${new Date().toTimeString().slice(0, 8)}  ${text}\n`);
	elemLog.scrollTop = elemLog.scrollHeight;
}

export function showError(message) {
	document.getElementById('my-error-text').textContent = message;
	bootstrap.Modal.getOrCreateInstance('#my-error-modal').show();
	logLine(`error: ${message}`);
}

// Resolves true only if the user picks the confirming button.
export function confirmAction({title, body, ok, cancel, okClass = 'btn-danger'}) {
	document.getElementById('my-confirm-title').textContent = title;
	document.getElementById('my-confirm-text').textContent = body;
	document.getElementById('my-confirm-cancel').textContent = cancel;
	const elemConfirmOk = document.getElementById('my-confirm-ok');
	elemConfirmOk.textContent = ok;
	elemConfirmOk.className = `btn ${okClass}`;
	const modal = bootstrap.Modal.getOrCreateInstance('#my-confirm-modal');

	return new Promise((resolve) => {
		let isConfirmed = false;
		const handleOkClick = () => {
			isConfirmed = true;
			modal.hide();
		};
		elemConfirmOk.addEventListener('click', handleOkClick);
		document.getElementById('my-confirm-modal').addEventListener('hidden.bs.modal', () => {
			elemConfirmOk.removeEventListener('click', handleOkClick);
			resolve(isConfirmed);
		}, {once: true});
		modal.show();
	});
}

export function downloadFile(name, bytes) {
	const url = URL.createObjectURL(new Blob([bytes], {type: 'application/octet-stream'}));
	const elemA = document.createElement('a');
	elemA.href = url;
	elemA.download = name;
	document.body.appendChild(elemA);
	elemA.click();
	elemA.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export const sleepMs = (ms) => new Promise((resolve) => {
	setTimeout(resolve, ms);
});

// "4 h 6 min", "12 min", "45 s"
export function formatTime(seconds) {
	seconds = Math.round(seconds);
	if (seconds < 90) {
		return `${seconds} s`;
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes} min`;
	}
	return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function formatBytes(bytes) {
	if (bytes >= 1024 * 1024) {
		const mib = bytes / (1024 * 1024);
		return `${(Number.isInteger(mib)) ? mib : mib.toFixed(1)} MiB`;
	}
	return `${Math.round(bytes / 1024)} KiB`;
}

// ---- Web MIDI
// Fills the two <select>s, follows plugging and unplugging, and keeps the chosen ports. `onChange` is called whenever
// the choice changes; `onMessage` gets every message from the chosen input, and the time it reached the PC.
export async function setupMidiPorts({elemIn, elemOut, onChange, onMessage}) {
	if (!navigator.requestMIDIAccess) {
		showError('This browser does not support Web MIDI.\n\n' +
			'Use Chrome, Edge, or Firefox, over HTTPS or from localhost. Safari does not support Web MIDI at all.');
		return null;
	}
	let midiAccess;
	try {
		midiAccess = await navigator.requestMIDIAccess({sysex: true});
	} catch (e) {
		showError(`Web MIDI access was refused: ${e.message}\n\n` +
			'If you use Chrome or Edge: reload the page and allow MIDI access in the popup.\n\n' +
			'If you use Firefox: reload the page and accept the add-on it offers, or check that the add-on ' +
			'already installed for this address has permission.');
		return null;
	}

	const ports = {input: null, output: null, isLocked: false};

	function fillSelect(elem, available) {
		const wasId = elem.options[elem.selectedIndex]?.id;
		elem.innerHTML = '<option>Disconnected</option>';
		for (const port of available) {
			const option = document.createElement('option');
			option.id = port.id;
			option.textContent = port.name;
			option.selected = (port.id === wasId);
			elem.appendChild(option);
		}
	}

	function pick(elem, available) {
		const id = elem.options[elem.selectedIndex]?.id;
		return [...available].find((port) => (port.id === id)) ?? null;
	}

	function refresh() {
		fillSelect(elemIn, midiAccess.inputs.values());
		fillSelect(elemOut, midiAccess.outputs.values());
		choose();
	}

	function choose() {
		if (ports.input) {
			ports.input.onmidimessage = null;
		}
		ports.input = pick(elemIn, midiAccess.inputs.values());
		ports.output = pick(elemOut, midiAccess.outputs.values());
		if (ports.input) {
			ports.input.onmidimessage = (event) => onMessage(event.data, event.timeStamp || performance.now());
		}
		onChange();
	}

	ports.lock = (isLocked) => {
		ports.isLocked = isLocked;
		elemIn.disabled = isLocked;
		elemOut.disabled = isLocked;
	};
	elemIn.addEventListener('change', choose);
	elemOut.addEventListener('change', choose);
	midiAccess.addEventListener('statechange', refresh);
	refresh();

	return ports;
}

// ---- the table of the 4 files
// One row per file, and the two files of a pair share a checkbox cell (rowspan) because they are read together:
// every 32-bit word of the ROM has its low half in one of them and its high half in the other.
export class FileTable {
	constructor(elemTable, {modelName, isSelectable, pairSeconds, onSelect, onSave}) {
		this.elemTable = elemTable;
		this.isSelectable = isSelectable;
		this.onSelect = onSelect;
		this.onSave = onSave;
		this.selectedPairs = new Set([0, 1]);
		this.rows = [];
		this.checkboxes = [];
		const elemBody = elemTable.querySelector('tbody');
		elemBody.replaceChildren();
		for (const [fileNo, file] of ROM_FILES.entries()) {
			const tr = document.createElement('tr');
			if (fileNo % 2 === 0) {
				const td = document.createElement('td');
				td.rowSpan = 2;
				td.className = 'my-pair align-middle';
				const checkbox = document.createElement('input');
				checkbox.type = 'checkbox';
				checkbox.className = 'form-check-input';
				checkbox.checked = true;
				checkbox.disabled = !isSelectable;
				checkbox.setAttribute('aria-label', `read pair ${file.pairNo + 1}`);
				checkbox.addEventListener('change', () => {
					if (checkbox.checked) {
						this.selectedPairs.add(file.pairNo);
					} else {
						this.selectedPairs.delete(file.pairNo);
					}
					this.onSelect?.();
				});
				this.checkboxes.push(checkbox);
				const label = document.createElement('div');
				label.className = 'small text-body-secondary my-pair-label';
				const range = formatDwordRange(file.pairNo * ROM_DWORDS / PAIR_COUNT, ROM_DWORDS / PAIR_COUNT);
				label.innerHTML = `${range}<br>about ${formatTime(pairSeconds)}`;
				td.append(checkbox, label);
				tr.appendChild(td);
			}
			const cells = `<td class="my-name"></td><td class="text-end">${formatBytes(FILE_SIZE)}</td><td class="my-holds"></td>` +
				'<td class="my-progress"><div class="progress" role="progressbar"><div class="progress-bar"></div></div></td>' +
				'<td class="my-status"></td><td class="text-end"><button type="button" class="btn btn-sm btn-outline-primary py-0" hidden>Save</button></td>';
			tr.insertAdjacentHTML('beforeend', cells);
			tr.querySelector('.my-holds').textContent = (file.isHigh) ? 'high 16 bits' : 'low 16 bits';
			const button = tr.querySelector('button');
			button.addEventListener('click', () => this.onSave?.(fileNo));
			this.rows.push({tr, name: tr.querySelector('.my-name'), bar: tr.querySelector('.progress-bar'), status: tr.querySelector('.my-status'), button});
			elemBody.appendChild(tr);
		}
		this.setModelName(modelName);
	}

	// The file names start with the model name, which the MU1000 page knows only after the connection check.
	setModelName(modelName) {
		for (const [fileNo, row] of this.rows.entries()) {
			row.name.textContent = makeFileName(modelName, fileNo);
		}
	}

	getSelectedPairs() {
		return [...this.selectedPairs].sort((a, b) => (a - b));
	}

	lock(isLocked) {
		for (const checkbox of this.checkboxes) {
			checkbox.disabled = isLocked || !this.isSelectable;
		}
	}

	// `image` is the RomImage; `state` says what the dump is doing: {isRunning, isStarted, currentPairNo, crcValues}.
	update(image, state) {
		for (const [fileNo, file] of ROM_FILES.entries()) {
			const row = this.rows[fileNo];
			const isSelected = this.selectedPairs.has(file.pairNo);
			const doneBytes = image.getFileDoneBytes(fileNo);
			const isComplete = (doneBytes === FILE_SIZE);
			const pct = Math.floor(100 * doneBytes / FILE_SIZE);
			row.bar.style.width = `${pct}%`;
			row.bar.textContent = (doneBytes) ? `${formatBytes(doneBytes)}` : '';
			row.bar.className = `progress-bar${(isComplete) ? ' bg-success' : ''}`;

			let text = '';
			let className = 'my-status';
			if (!isSelected && !doneBytes) {
				text = 'not selected';
				className += ' text-body-secondary';
			} else if (isComplete) {
				const crc32 = state.crcValues?.[fileNo];
				text = (crc32 === undefined) ? 'complete' : `complete, CRC32: ${crc32.toString(16).toUpperCase().padStart(8, '0')}`;
				className += ' text-success';
			} else if (state.isRunning) {
				text = (state.currentPairNo === file.pairNo) ? 'reading...' : 'waiting...';
			} else if (state.isStarted) {
				text = (doneBytes) ? `stopped at ${formatBytes(doneBytes)}` : 'not read';
				className += ' text-warning-emphasis';
			}
			row.status.textContent = text;
			row.status.className = className;
			row.button.hidden = !isComplete;
		}
	}
}

export function formatDwordRange(firstDword, count) {
	const hex = (n) => n.toString(16).toUpperCase().padStart(7, '0');
	return `${hex(firstDword * 4)}H - ${hex((firstDword + count) * 4 - 1)}H`;
}
