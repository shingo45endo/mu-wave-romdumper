#!/usr/bin/env node
/*
	Build the MIDI files to put on the SmartMedia card, for saving the wave ROM as WAV files.

	  node tools/make_card_smf.js [--out card]

	  WAVEROM.MID   sample 512 "WAVEROM" = the whole ROM, 32 MiB (for a card of 64 MB or more)
	  WAVE4.MID     samples 509 to 512 "WAVEROM1" to "WAVEROM4" = 8 MiB each

	The synth plays a file from the card with its sequencer, and the SysEx in it works as if it came in at MIDI In.
	Each message is there once for every device number, so that it works whatever the synth is set to.
*/

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';
import util from 'node:util';

import {SAMPLE_COUNT, buildSampleRecord, buildSampleName} from '../lib/sysex.js';
import {ROM_DWORDS} from '../lib/rom_image.js';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');

const PART_DWORDS = ROM_DWORDS / 4;	// 8 MiB
const GAP_MS      = 100;

// The samples used, from the last one down, so that samples a user made are left alone as long as possible.
const WHOLE_SAMPLE_NO = SAMPLE_COUNT - 1;
const PART_SAMPLE_NOS = [SAMPLE_COUNT - 4, SAMPLE_COUNT - 3, SAMPLE_COUNT - 2, SAMPLE_COUNT - 1];

// The messages of each file, for one device number.
export const CARD_FILES = [
	{
		name: 'WAVEROM.MID', title: 'MU2000 wave ROM, 32 MiB as one sample',
		buildMessages: (device) => [
			buildSampleRecord(WHOLE_SAMPLE_NO, {startDword: 0, endDword: ROM_DWORDS}, device),
			buildSampleName(WHOLE_SAMPLE_NO, 'WAVEROM', device),
		],
	},
	{
		name: 'WAVE4.MID', title: 'MU2000 wave ROM, 4 samples of 8 MiB',
		buildMessages: (device) => PART_SAMPLE_NOS.flatMap((sampleNo, i) => [
			buildSampleRecord(sampleNo, {startDword: i * PART_DWORDS, endDword: (i + 1) * PART_DWORDS}, device),
			buildSampleName(sampleNo, `WAVEROM${i + 1}`, device),
		]),
	},
];

// A format 0 file with one SysEx event per message, GAP_MS apart. A tick is a millisecond: 1000 ticks per quarter
// note, one second per quarter note.
export function writeSmf(messages, title) {
	const eventBytes = [];
	const titleBytes = Array.from(title, (c) => c.charCodeAt(0));
	eventBytes.push(...toVlq(0), 0xff, 0x03, ...toVlq(titleBytes.length), ...titleBytes);
	eventBytes.push(...toVlq(0), 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40);	// 1,000,000 us per quarter note
	for (const [i, message] of messages.entries()) {
		eventBytes.push(...toVlq((i) ? GAP_MS : 0), 0xf0, ...toVlq(message.length - 1), ...message.slice(1));
	}
	eventBytes.push(...toVlq(GAP_MS), 0xff, 0x2f, 0x00);

	const toBe32 = (value) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
	return Uint8Array.from([
		0x4d, 0x54, 0x68, 0x64,		// "MThd"
		...toBe32(6),
		0x00, 0x00,					// format 0
		0x00, 0x01,					// 1 track
		0x03, 0xe8,					// 1000 ticks per quarter note
		0x4d, 0x54, 0x72, 0x6b,		// "MTrk"
		...toBe32(eventBytes.length),
		...eventBytes,
	]);
}

function toVlq(value) {
	const bytes = [value & 0x7f];
	value >>= 7;
	while (value) {
		bytes.unshift((value & 0x7f) | 0x80);
		value >>= 7;
	}
	return bytes;
}

// The messages for every device number. A synth set to All takes all 16, which all say the same.
export function buildAllDeviceMessages(file) {
	return Array.from({length: 16}, (_, device) => file.buildMessages(device)).flat();
}

function printUsageAndExit(message) {
	if (message) {
		process.stderr.write(`make_card_smf: ${message}\n\n`);
	}
	process.stderr.write('usage: node tools/make_card_smf.js [--out card]\n' +
		'  --out   where to write (default: card)\n');
	process.exit((message) ? 2 : 0);
}

function main() {
	let values;
	try {
		({values} = util.parseArgs({
			args: process.argv.slice(2),
			options: {
				help: {type: 'boolean', short: 'h'},
				out: {type: 'string', default: path.join(ROOT, 'card')},
			},
		}));
	} catch (e) {
		printUsageAndExit(e.message);
	}
	if (values.help) {
		printUsageAndExit();
	}

	fs.mkdirSync(values.out, {recursive: true});
	for (const file of CARD_FILES) {
		const messages = buildAllDeviceMessages(file);
		fs.writeFileSync(path.join(values.out, file.name), writeSmf(messages, file.title));
		process.stderr.write(`wrote ${path.join(values.out, file.name)}: ${messages.length} messages\n`);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
	main();
}
