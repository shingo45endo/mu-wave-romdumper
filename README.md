mu-wave-romdumper
=================


What is this?
-------------

Dump the wave ROM of a Yamaha MU2000 or MU1000 over MIDI, from a web page.

* You do not need to open the case or change the firmware. The page only sends SysEx messages that the firmware already understands.
* The result is 4 ROM image files of 8 MiB each.
* Everything runs in your browser. No data is uploaded.


Supported Models
----------------

| Model            | Page        | Time for the whole ROM | Stop and continue later     | Testing on a real device |
| ---------------- | ----------- | ---------------------- | --------------------------- | ------------------------ |
| MU2000, MU2000EX | MU2000 page | about 4 h              | No (each half is about 2 h) | in progress              |
| MU1000, MU1000EX | MU1000 page | about 20 h             | Yes                         | not yet                  |

* The MU1000 page also works on an MU2000, but the MU2000 page is 5 times faster.
* The MU128 is not supported. Its firmware has no SysEx message that reads the registers of the sound chip.


How to Use
----------

1. Connect MIDI In and MIDI Out of the synth to your MIDI interface.
2. Open the page for your model in Chrome, Edge or Firefox. Allow MIDI access.
3. Choose the MIDI ports, and press "Check connection".
4. Press "Start dump". Keep the tab open. Do not send anything else to the synth.
5. When a pair of files is complete, press "Save" or "Save all files".

### MU2000 page

* The ROM is 2 pairs of files. You can read one pair (about 2 hours) or both (about 4 hours).
* If you stop the dump, the pair that is not complete must be read again from its start.

### MU1000 page

* The page reads the whole ROM, from the start to the end.
* The progress is saved in the browser all the time. You can stop the dump, or close the page, at any time. When you open the page again, "Resume dump" continues from there.
* When the dump is complete, the files stay in the browser until you press "Discard". You can save them later.
* Before it continues, the page reads some data again and compares it with the saved data. If the synth is not the same one, it does not continue.
* Use the same browser on the same PC to continue. The progress is not kept if you clear the site data of the browser.

### Without a browser

For the MU2000, there is also a way without a MIDI interface. The synth saves the wave ROM to its SmartMedia card as WAV files, and a command line tool makes the ROM files from them. You need a card and a card reader. See [cli/README.md](cli/README.md).

### What you need

* An MU2000 or MU1000 (also the EX models)
* A MIDI interface, with both In and Out connected
* A browser with Web MIDI: Chrome, Edge or Firefox. Safari does not have Web MIDI.
	* Chrome and Edge: allow MIDI access in the popup.
	* Firefox: install the site permission add-on that the browser offers.


Output Files
------------

The wave ROM is 32 MiB. It is 4 mask ROMs of 8 MiB, in 2 pairs. Each pair is on a 32-bit bus: one ROM has the low 16 bits of each word, and the other has the high 16 bits. So the 2 files of a pair are always read together.

| File                       | Range in the ROM  | Holds        |
| -------------------------- | ----------------- | ------------ |
| `mu2000_wave_000_low.bin`  | 0000000H-0FFFFFFH | low 16 bits  |
| `mu2000_wave_000_high.bin` | 0000000H-0FFFFFFH | high 16 bits |
| `mu2000_wave_100_low.bin`  | 1000000H-1FFFFFFH | low 16 bits  |
| `mu2000_wave_100_high.bin` | 1000000H-1FFFFFFH | high 16 bits |

* The name starts with the model: `mu2000_` or `mu1000_`. The number is where the pair starts, in units of 64 KiB.
* Each file has 16-bit words in little-endian order.
* The MU1000 and the MU2000 have the same wave ROM.


How it works
------------

### The wave memory

* The sound chip of the MU1000 and the MU2000 is the Yamaha SWP30. The wave ROM is connected to the SWP30, not to the CPU.
* The MU2000 also has a sampling RAM (4 MiB). It is connected to the SWP30 too. For the SWP30, the wave ROM and the sampling RAM are in one address range. Only the address is different.
* The CPU cannot read this memory directly. It uses registers of the SWP30:
	1. Write the address and the number of words.
	2. Start the read.
	3. Read the data from a data register, one word at a time.

### MU1000 page: register messages

The firmware has 2 SysEx messages that are not in the manual. With them, a PC can do the same as the CPU:

* A message that reads one register of the SWP30, and sends back its value.
* A message that writes values to registers of the SWP30.

So the page writes the address with the write message, starts the read, and reads the data register with the read message. This works on the MU1000 and the MU2000, but it is slow:

* Each answer has only 16 bits of data.
* The firmware reads the data register 2 times for each request, and every read moves to the next word. So one pass gets only half of the bits, and the page reads each block 2 times.

The whole ROM takes about 20 hours.

### MU2000 page: sampling messages

The MU2000 has SysEx messages that move samples between a PC and the sampling RAM. They are not in the manual either.

* One of them asks for 64 bytes from a "write position" in the sampling RAM. The synth sends the 64 bytes back, and moves the position forward by 64 bytes.
* The firmware adds the start address of the sampling RAM to the position. It calculates in 32 bits, and it does not check the range. With a large position, the sum goes past the largest 32-bit value, starts again from 0, and points into the wave ROM.
* So the same message reads the wave ROM. The page only reads. It never writes anything with these messages.

This is about 5 times faster than the register messages:

* One request gets 64 bytes.
* The synth's own CPU does the work with the registers of the SWP30. Only the 64 bytes go over MIDI.
* The 64 bytes are packed into 74 bytes of MIDI data. The register messages need 4 bytes of MIDI data for every 2 bytes of the ROM.

The speed of the MIDI cable is the limit: about 4 hours for the whole ROM.

### Checking the data

* An answer has no address in it. So the page reads in small blocks, and it sets the address again before each block.
* If an answer is lost or broken, the page reads the block again. If the synth stops answering for a while, the page also reads the block again. It drops the answers that come too late.
* The firmware's test mode checks some words of the ROM against a table. The page uses the same values, so a wrong model or a wiring problem is found in the first seconds.


License
-------

MIT


Author
------

[shingo45endo](https://github.com/shingo45endo)
