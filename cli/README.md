Command line tool
=================

For the MU2000, the wave ROM can also be dumped without a MIDI interface. The synth saves the ROM to its SmartMedia card as WAV files, and a command line tool makes the ROM files from them.

* You need a SmartMedia card and a card reader for your PC.
* The synth writes the card by itself, so this is much faster than the MIDI cable.
* The tool is a plain ES module with no dependencies. It runs on **Node** (20 or newer, for `node:util`'s `parseArgs`).

Only the MU2000 is supported. The MU1000 has no sampling.


How to Use
----------

1. Copy the files in `card/` to the card with your card reader, and put the card in the MU2000.
2. Play one of these files on the synth. You can play it from the card with the sequencer of the synth, or send it from your PC over MIDI.

	| File          | What it does                                                  | Free space on the card          |
	| ------------- | ------------------------------------------------------------- | ------------------------------- |
	| `WAVEROM.MID` | sample 512 "WAVEROM" becomes the whole ROM (32 MiB)           | 32 MiB: a card of 64 MB or more |
	| `WAVE4.MID`   | samples 509 to 512 "WAVEROM1" to "WAVEROM4" become 8 MiB each | 8 MiB for each WAV file         |

	The file has only SysEx messages. It plays no sound. From the card:

		[SEQ] → `SONG` → `Load` → `WAVEROM.MID` → `Play:WAVEROM` → `SMF Start [Enter]`

3. Save the sample to the card as a WAV file. With `WAVE4.MID`, save samples 509 to 512 in the same way.

		[SAMPLING] → `SAVE` → `WAV` → `Sp=512` → `File Name [ WAVEROM ]`

	Saving the whole ROM takes about 24 minutes.
4. Copy the WAV files to your PC, and run:

		node cli/extract.js WAVEROM.WAV -d roms/

	or, with the 4 files of `WAVE4.MID`, in any order:

		node cli/extract.js WAVEROM1.WAV WAVEROM2.WAV WAVEROM3.WAV WAVEROM4.WAV -d roms/

`extract.js` says where each WAV file goes, and writes the files of every complete pair, with the CRC32 of each:

	  0000000H-07FFFFFH  WAVEROM.WAV
	  0800000H-0FFFFFFH  WAVEROM.WAV
	  1000000H-17FFFFFH  WAVEROM.WAV
	  1800000H-1FFFFFFH  WAVEROM.WAV

	  file                           size  status
	  mu2000_wave_000_low.bin     8388608  complete, CRC32 ...
	  mu2000_wave_000_high.bin    8388608  complete, CRC32 ...
	  mu2000_wave_100_low.bin     8388608  complete, CRC32 ...
	  mu2000_wave_100_high.bin    8388608  complete, CRC32 ...

The files are the same as the ones the MU2000 page makes.

### Notes

* The files in `card/` work whatever the device number of the synth is.
* Samples 509 to 512 are changed. If you use these numbers, save your own samples first.
* The samples only point at the wave ROM. Nothing is written to the sampling RAM. They are gone when the synth is turned off.
* A card of 32 MB is too small for `WAVEROM.MID`. Use `WAVE4.MID`: 3 of the WAV files fit on the card at one time.
* To make the files in `card/` again: `node tools/make_card_smf.js`


How it works
------------

* The sampling SysEx messages of the MU2000 (see the top README) also set where the data of a sample is.
* The firmware adds the start address of the sampling RAM to that address, in 32 bits, like the write position. So a sample can point at the wave ROM.
* When the synth saves such a sample as a 16-bit WAV file, the data of the file is the wave ROM, in little-endian 32-bit words.
* `extract.js` finds where each part of the data belongs from the words that the firmware's test mode checks. Then it splits each pair of the ROM into its low and high 16 bits.
