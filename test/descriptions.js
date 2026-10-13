/**
 * What each test does, in one or two plain sentences, for the report: behind every test row's collapsible, before the
 * measured diagnostics. Keyed by test file, then by the test's name as node:test reports it (a subtest by its own
 * name). A name with a variant-specific suffix in parentheses - e.g. "(the double-join finding under ASan)" - finds
 * the entry of the name without it.
 *
 * Every test needs an entry: `node scripts/report.mjs check <results>` (a CI job) fails on a test without one, so a
 * new test comes with its explanation. Keep them short, concrete and free of internal jargon.
 */

const rfd = 'rfd, the BidCoS radio daemon,';

export const DESCRIPTIONS = Object.freeze({
    'test/daemon/hs485d-lgw.test.js': {
        'hs485d connects through the gateway: the hello and the switch, an empty bus, the keepalive every 20 s':
            'hs485d, the wired daemon, connects to a simulated wired LAN gateway (HMW-LGW). The test checks the greeting, the switch to the binary protocol and the keepalive every 20 seconds.',
        'AES: hs485d through the encrypted gateway (-k): the V handshake, the binary protocol inside the cipher':
            'The same connection with a LAN key: hs485d and the gateway agree on the encryption and then talk the binary protocol through it.',
        'discovery: searchDevices finds the actuator - D, d, c, then h/v, the EEPROM usage and the lists; newDevices':
            'A device search on the wired bus finds the simulated actuator; hs485d reads its type, version and memory and announces it to the event receiver.',
        'a set: LEVEL_SET to the switch channel, the ACK, the INFO_LEVEL event; getValue asks with LEVEL_GET':
            'Switching a wired channel on: hs485d sends the command, the actuator confirms, and the new state arrives as an event. Reading the value asks the device.',
        'a key press on the actuator: PRESS_SHORT and PRESS_LONG events':
            "A short and a long press on the actuator's key reach the event receiver as PRESS_SHORT and PRESS_LONG.",
        'a device announces itself (A, broadcast): hs485d adds it without a search':
            'A new wired device that announces itself on the bus is taken in by hs485d without a manual search.',
        'putParamset writes the EEPROM (W) and getParamset reads it back; the write of a key channel':
            "Changing a device's settings writes them into its memory; reading them back returns what was written.",
        'a link from the key to the switch channel: addLink writes the link EEPROM, getLinks shows it, removeLink':
            'A direct link from a key to a switch channel is created, listed and removed again, with the device memory updated each time.',
        'UNREACH can be read on the maintenance channel':
            "The device's maintenance channel answers the question whether the device is unreachable.",
        'UNREACH and STICKY_UNREACH events after the failed write':
            'After a write to a silent device fails, the receiver is told that the device is unreachable, also in the sticky form a user has to confirm.',
        'a silent device: the send fails (a 01, two tries), the set faults; the maintenance channel of a discovered device (wired-maintenance)':
            'A wired device stops answering: the gateway reports the failure, hs485d tries twice and the set call returns an error.',
        'keepalive timeout: the gateway stops answering K - hs485d finds it again over UDP and reconnects':
            'When the gateway stops answering the keepalive, hs485d looks for it on the network again and reconnects.',
        'restart: the device file keeps the device, its sysinfo and config; a type byte >= 0x80 survives (#9 shape)':
            'After a restart hs485d loads the device from its file with the same type, version and settings, including type codes above 127.',
    },
    'test/daemon/hs485d-rpc.test.js': {
        'hs485d starts against a silent bus and serves listMethods and an empty listDevices':
            'hs485d starts without any wired hardware answering and still serves its remote interface.',
        '#138 on hs485d: a nested system.multicall is refused, hs485d stays up':
            'A deeply nested multicall request, which used to overflow the stack, is refused and hs485d keeps running.',
        '#140 on hs485d: malformed BIN-RPC requests never crash it':
            'Broken binary requests with impossible length fields get an error or a closed connection, never a crash.',
    },
    'test/daemon/hs485d-sweep.test.js': {
        'method sweep: system.listMethods of hs485d is the dispatcher table of its source':
            'The list of methods hs485d reports matches the method table in its source code, so a method added or removed upstream shows up here.',
        'method sweep: every hs485d method with valid, missing, extra and wrong-typed arguments; hs485d stays up, no sanitizer report':
            'Every method of hs485d is called with correct, missing, extra and wrongly typed arguments; the daemon must answer each call and stay up.',
        'device-type sweep: one wired device of every hs485types type, discovered; descriptions, paramsets and values':
            'One simulated device of every wired type is discovered, and its descriptions, settings and values are read.',
    },
    'test/daemon/listmethods-truth.test.js': {
        'rfd over binrpc: every listed method is callable, no unlisted name is (system.methodHelp and direct calls)': `${rfd} must be able to call every method it lists, and nothing it does not list (binary protocol).`,
        'rfd over xmlrpc: every listed method is callable, no unlisted name is (system.methodHelp and direct calls)': `${rfd} must be able to call every method it lists, and nothing it does not list (XML-RPC).`,
        'hs485d over binrpc: every listed method is callable, no unlisted name is (system.methodHelp and direct calls)':
            'hs485d must be able to call every method it lists, and nothing it does not list (binary protocol).',
        'hs485d over xmlrpc: every listed method is callable, no unlisted name is (system.methodHelp and direct calls)':
            'hs485d must be able to call every method it lists, and nothing it does not list (XML-RPC).',
    },
    'test/daemon/parsers.test.js': {
        'telegrams from a paired device with mutated content reach the device model and do not crash rfd (seeded)':
            'Hundreds of randomly altered radio telegrams arrive from a paired switch; rfd must process them all and keep working.',
        'a malformed JSON value for USER_COLOR (HM-LC-RGBW-WM, a parameter with write dependencies) is refused, rfd lives (finding json-substr)':
            'Setting the colour of an RGBW controller with broken JSON must give an error; today one such call ends rfd.',
        'a configuration line longer than 255 characters: rfd starts (finding propertymap-long-line)':
            'A long line in the configuration file must not stop rfd from starting; today it hangs for ever while reading it.',
        'a wired firmware file without a data record: hs485d reports no firmware and lives (finding hexfile-no-data)':
            'An empty or cut-off firmware file for a wired device must not crash hs485d; today the next device search does.',
        'hs485d device directory: a directory named X.dev and an empty .dev are skipped, the good device stays':
            'Junk in the device directory - a folder named like a device file and an empty file - is skipped and the real device comes back.',
    },
    'test/daemon/receiver-contract.test.js': {
        'rfd: three receivers - each is synced with its own id; ping sends PONG to all; 20 events arrive in order at each': `Three programs register for events with ${rfd.slice(0, -1)}; each is synchronised with its own id and gets all events in order.`,
        "rfd: init sync - the receiver's listDevices decides: unknown addresses deleted, another VERSION re-sent, the same VERSION left out":
            "When a program registers, rfd compares its device list with the program's and sends only what changed.",
        'rfd: the unreachable rule - ten failed deliveries in a row remove a receiver at the next event, a success resets the count':
            'A program that keeps failing to take events is dropped after ten failures in a row; one success resets the count.',
        'rfd: a hanging receiver delays only itself - the others get their events at once, RPC keeps answering':
            'A program that stops responding must not hold up events for the others or the remote interface.',
        'hs485d: three receivers - each is synced with its own id; ping sends PONG to all; 20 events arrive in order at each':
            'Three programs register for events with hs485d; each is synchronised with its own id and gets all events in order.',
        "hs485d: init sync - the receiver's listDevices decides: unknown addresses deleted, another VERSION re-sent, the same VERSION left out":
            "When a program registers, hs485d compares its device list with the program's and sends only what changed.",
        'hs485d: the unreachable rule - ten failed deliveries in a row remove a receiver at the next event, a success resets the count':
            'A program that keeps failing to take events is dropped after ten failures in a row; one success resets the count.',
        'hs485d: a hanging receiver delays only itself - the others get their events at once, RPC keeps answering':
            'A program that stops responding must not hold up events for the others or the remote interface.',
        'rfd: service messages are re-sent to a receiver that registers later (UNREACH of a silent switch)':
            'A program that registers late still learns about an earlier problem, such as an unreachable device.',
        'rfd: replaceDevice - every registered receiver is told replaceDevice(id, old, new) when it happens':
            'When a device is replaced by a new one, every registered program is told.',
        'rfd: replaceDevice - a receiver that still lists the old device gets replaceDevice(old, new) at init, not deleteDevices (the replace-callback finding)':
            'A program that missed a replacement should learn about it when it registers again; today it is told the old device was deleted instead.',
        'hs485d: replaceDevice - every registered receiver is told replaceDevice(id, old, new) when it happens':
            'When a wired device is replaced by a new one, every registered program is told.',
        'hs485d: replaceDevice - a receiver that still lists the old device gets replaceDevice(old, new) at init, not deleteDevices (the replace-callback finding)':
            'A program that missed a replacement should learn about it when it registers again; today it gets the wrong answer.',
    },
    'test/daemon/receiver-misbehaviour.test.js': {
        'rfd, binrpc callbacks: a receiver that misbehaves on events (close, close-partial, vanish, no-answer, no-read, http-500, fault, garbage, truncated, wrong-type, huge, trickle, twice) holds up no other receiver, no RPC, no radio, and leaks nothing':
            'An event receiver misbehaves in thirteen ways - hanging up mid-answer, never answering, sending garbage - and rfd must keep serving everything else without leaking resources (binary protocol).',
        'rfd, xmlrpc callbacks: a receiver that misbehaves on events (close, close-partial, vanish, no-answer, no-read, http-500, fault, garbage, truncated, wrong-type, huge, trickle, twice) holds up no other receiver, no RPC, no radio, and leaks nothing':
            'The same thirteen kinds of misbehaving receiver over XML-RPC; rfd must keep serving everything else.',
        'rfd: init with a receiver that answers listDevices with a huge or an invalid list - the daemon survives and answers':
            'A registering program answers with an enormous or nonsensical device list; rfd must survive and keep answering.',
        'rfd: init with a receiver that never answers stalls the daemon at most for the callback timeout, then it recovers by itself (the init-blocks finding)':
            'A program that registers and then never answers may stall rfd for the callback timeout at most; before OpenCCU-Base #170 the whole daemon waited for it for good.',
        'rfd: a receiver that never answers newDevices leaves no thread behind per init (the async-callback-threads finding)':
            'Each unanswered device announcement should not leave a thread behind; today every one does, for good.',
        'rfd: a client re-registering in a tight loop, two receivers with one id, a receiver URL that leads nowhere':
            'Odd but legal client behaviour - registering again and again, a shared id, an address nobody listens on - must not upset rfd.',
        'hs485d, binrpc callbacks: a receiver that misbehaves on events (close, close-partial, vanish, no-answer, no-read, http-500, fault, garbage, truncated, wrong-type, huge, trickle, twice) holds up no other receiver, no RPC, no radio, and leaks nothing':
            'An event receiver misbehaves in thirteen ways and hs485d must keep serving everything else without leaking resources (binary protocol).',
        'hs485d, xmlrpc callbacks: a receiver that misbehaves on events (close, close-partial, vanish, no-answer, no-read, http-500, fault, garbage, truncated, wrong-type, huge, trickle, twice) holds up no other receiver, no RPC, no radio, and leaks nothing':
            'The same thirteen kinds of misbehaving receiver over XML-RPC; hs485d must keep serving everything else.',
        'hs485d: init with a receiver that answers listDevices with a huge or an invalid list - the daemon survives and answers':
            'A registering program answers with an enormous or nonsensical device list; hs485d must survive and keep answering.',
        'hs485d: init with a receiver that never answers stalls the daemon at most for the callback timeout, then it recovers by itself (the init-blocks finding)':
            'A program that registers and then never answers may stall hs485d for the callback timeout at most; before OpenCCU-Base #170 the whole daemon waited for it for good.',
        'hs485d: a receiver that never answers newDevices leaves no thread behind per init (the async-callback-threads finding)':
            'Each unanswered device announcement should not leave a thread behind; today every one does, for good.',
        'hs485d: a client re-registering in a tight loop, two receivers with one id, a receiver URL that leads nowhere':
            'Odd but legal client behaviour must not upset hs485d.',
    },
    'test/daemon/restart-config.test.js': {
        'rfd restart: one device of every rftypes type, stopped through exit, comes back from its file with the same address, type, version and channels':
            'One device of every radio type is created, rfd is stopped and started again, and every device must come back unchanged from its file.',
        'rfd restart: a truncated file, a garbage file, an empty file, a directory named X.dev, leftover .bak/.new copies and a file missing a channel - rfd starts and keeps the good devices':
            'Damaged and stray files in the device directory must not stop rfd from starting with the good devices.',
        'rfd restart: a truncated file, a garbage file, leftover .bak/.new copies and a file missing a channel - rfd starts and keeps the good devices':
            'Damaged and stray files in the device directory must not stop rfd from starting with the good devices.',
        'rfd address donation: with BidCoS-Address = 0 rfd takes the module default address and writes it to the address file':
            'Without a configured radio address, rfd takes the one the radio module suggests and remembers it.',
        'rfd receiver persistence: a registered receiver is called again after a restart, without a new init':
            'A program registered for events keeps getting them after rfd restarts, without registering again.',
        'rfd key file: changeKey writes the new key and index to the key file, a restart loads them (Persist Keys = 1)':
            'A changed security key is saved and still in use after a restart.',
        'rfd -f with a missing config file: it says so and does not run':
            'Started with a configuration file that does not exist, rfd says so and does not run.',
        'rfd with an unknown interface Type: no interface, rfd does not run (and does not crash)':
            'A radio interface of an unknown type in the configuration makes rfd stop cleanly, not crash.',
        'rfd log destinations: File writes to Log Filename, None writes nothing; RPC works either way':
            'Logging to a file or to nowhere works, and the remote interface is unaffected.',
        'rfd UDS File: the same RPC server on a unix-domain socket':
            'rfd also serves its remote interface on a local socket file.',
        'rfd with its port taken: "Could not bind", exit 0':
            'When its network port is already in use, rfd reports it and exits.',
        'rfd with two interfaces: two simulated modules, both listed and connected, one of them the default':
            'With two radio modules configured, rfd connects both and picks one as the default.',
        'rfd with the legacy coprocessor initialisation (Improved Coprocessor Initialization = false) gets its interface connected':
            "rfd's older start-up sequence for the radio module still brings the module online.",
        'rfd in sniffing mode (-s): starts without the device model and still answers RPC':
            "rfd's diagnostic listening mode starts without devices and still answers the remote interface.",
        '#164 SIGTERM: rfd leaves its main loop and exits 0 - with the pty module and behind the LAN gateway':
            'Stopped with the signal the init system sends, rfd ends cleanly with exit code 0 instead of being killed: its threads are joined and the radio module or LAN gateway is closed (OpenCCU-Base #164).',
        '#164 SIGTERM: hs485d behind the wired LAN gateway leaves its main loop and exits 0':
            'Stopped with the signal the init system sends, hs485d ends cleanly with exit code 0 instead of being killed (OpenCCU-Base #164).',
        'hs485d restart: every wired type comes back from its file with the same address, type, version and channels':
            'One device of every wired type is discovered, hs485d is restarted, and every device must come back unchanged.',
        'hs485d reads extra descriptions from /etc/config/hs485types: a type only described there is discovered as that type':
            'A device type described only in the user directory for extra descriptions is recognised.',
    },
    'test/daemon/rfd-aes-cbc.test.js': {
        'CBC-MAC: signed events with a growing counter are accepted; a wrong MIC and a replayed counter are dropped (#4)':
            'Some sensors sign their messages with a counter and a cryptographic checksum (CBC-MAC) instead of the usual AES handshake. On a channel marked for this, rfd must accept correctly signed messages with a rising counter and drop messages with a wrong checksum or an old counter.',
        'correctly signed events reach the receiver':
            'Two signed status messages with counters that go up both arrive as events.',
        'a wrong MIC is dropped': 'A message whose checksum does not match is dropped, and rfd logs the failed check.',
        'a replayed or lower counter is dropped, even with a valid MIC':
            'A correctly signed message with a counter that was already used, or a lower one, is dropped as a replay.',
        'CBC-MAC: the counter survives a restart (aes_cbc_cnt in the device file)':
            'rfd stores the last accepted counter in the device file. After a restart, a message with an older counter is still dropped and the next one is accepted.',
        'CBC-MAC: a device with the default key (index 0) passes the check even with a wrong MIC, but its values count as not authenticated (rfd asks the device instead)':
            'For a device still on the default key rfd skips the checksum check, for compatibility. The message is not treated as authenticated though: rfd does not take its value and asks the device for its state instead.',
    },
    'test/daemon/rfd-aes-remote.test.js': {
        'an AES-secured switch: the key exchange at pairing, a set runs the challenge-response, AUTHENTICATION_SUCCESS':
            'A switch with secured commands is paired; rfd hands it the key, and switching then runs through the challenge and response that proves the key.',
        'a remote: pairing, PRESS_SHORT and PRESS_LONG events, authenticated through the challenge the module issues':
            'A remote control is paired and its key presses arrive, each one verified with the shared key.',
        'config for a sleeping remote (rx mode CONFIG): the write fails, CONFIG_PENDING, delivered when it announces itself':
            "A setting for a remote that is asleep stays pending and is delivered when the remote's config button is pressed.",
        'a link between the remote and the switch: addLink writes the peer lists, getLinks shows it, removeLink clears it':
            'A direct link from the remote to the switch is created, listed, configured and removed again.',
    },
    'test/daemon/rfd-link-registers.test.js': {
        "HM-OU-CFM-TW: a link's LONG_ACT_TYPE is written to register 0xA4, SHORT_ACT_TYPE stays on 0x24 (#63)":
            "The MP3 chime's LED has separate settings for a short and a long key press in a direct link. Before fix #63 rfd wrote both into the same device register, so setting the long action overwrote the short one; now the long action goes to its own register.",
        'the long action on 0xA4, the short one kept on 0x24':
            'After writing both settings, the device holds the short action in register 0x24 and the long action in register 0xA4.',
    },
    'test/daemon/rfd-lgw-front.test.js': {
        'AES: rfd connects through the encrypted gateway - V handshake on both ports, keepalives, the init':
            'rfd connects to a simulated LAN gateway (HM-LGW) with a LAN key, agrees on the encryption on both channels and brings the radio module online through it.',
        'AES: a wrong LAN key - rfd decrypts garbage, sees no switch command, reports WRONG_KEY and gives the interface up':
            'With the wrong LAN key rfd cannot understand the gateway, reports it and gives up on the interface.',
        'plaintext through the JavaScript front: no V, the same init as through hmlangw':
            'The same gateway without encryption, as with the hmlangw tool.',
        'AES: port 2000 dropped - rfd reconnects both ports and re-initialises the module (#13)':
            'When the data connection to the gateway drops, rfd reconnects both channels and starts the radio module again.',
        'AES: port 2001 dropped - rfd reconnects both ports and re-initialises the module (#13)':
            'When the keepalive connection drops, rfd reconnects both channels and starts the radio module again.',
        'AES: a silent keepalive - no >K within 4 s makes rfd reconnect':
            'When the gateway stops answering the keepalive, rfd reconnects within seconds.',
        'AES: the gateway gone and back; the first hello after it says another serial and is rejected, the next one accepted (#17)':
            'The gateway disappears and comes back; a greeting with the wrong serial number is rejected, the right one accepted.',
        'AES: port 2000 dropped while a telegram is in flight - no crash, the set fails, the reconnect follows (#16 shape)':
            'The connection drops while a command is on its way: the command fails, rfd does not crash and reconnects.',
        'the AES policy of the remote is restored':
            "After the radio module restarts, the remote's security settings should be back in the module; today they are not.",
        'a key press after the re-init reaches the receiver': 'A key press after the restart still arrives.',
        'AES: the module power-cycled behind the gateway - rfd republishes the paired devices and keys (restoreConfigToCoprocessor), but not the AES policy':
            'The radio module behind the gateway loses power and comes back: rfd hands it the paired devices and keys again, but not the per-channel security settings.',
    },
    'test/daemon/rfd-lgw-recovery.test.js': {
        'AES: the restore after a reconnect fails twice (SET_CLOCK answered with an error) - rfd drops the connection, retries after 5 s and is back only with a complete restore (#13)':
            'After the gateway connection drops, the radio module rejects the clock setting twice while rfd restores its configuration. rfd must not treat the half-restored module as ready: it disconnects, waits 5 seconds, reconnects and comes back only once the restore has gone through.',
        'a failed restore is not taken as recovered':
            'Each failed restore ends in a new TCP connection after a 5-second pause, not in a working interface.',
        'the last restore is complete: key, device, clock':
            'The restore that finally succeeds sends the AES key, the paired device and the clock to the module again.',
        'AES: the coprocessor does not answer after the TCP reconnect (IDENTIFY dropped twice) - rfd sends no telegram meanwhile and retries until it answers (#13)':
            'The gateway is back, but the radio module behind it does not answer at first. rfd must not count the TCP connection alone as recovered, must not send radio telegrams while the module is being set up, and retries until the module answers.',
        'a TCP connection without a coprocessor is not taken as recovered':
            'rfd reconnects again after each unanswered greeting instead of declaring the interface ready.',
        'no SEND_TELEGRAM before the restore has finished':
            'Switch commands issued during the re-initialisation are not sent to the module before its configuration is restored.',
        'AES: the module restarts behind the gateway and the restore fails 3 times - rfd retries 1 s apart, then schedules a gateway reconnect (#13)':
            'The radio module restarts while the gateway stays connected, and restoring its configuration fails three times. rfd retries twice, one second apart, and then starts a fresh gateway connection, after which everything works again.',
        '3 restore attempts, then a new gateway connection':
            'Two retry messages, one scheduled reconnect, and a new connection to the gateway.',
        'AES: three reconnects leave no bidcos-channel keepalive thread behind - the thread count is back where it was (#13)':
            'Before fix #13 every gateway reconnect left one background keepalive thread running. After three reconnects rfd must have no more threads than before.',
        'no leaked thread': "The number of rfd's threads after three reconnects is not higher than before them.",
        'AES: SET_CLOCK fails during the start - the interface does not come up as connected (#13)':
            'The radio module rejects the clock setting while rfd starts: the gateway interface must not be reported as connected (rfd gives the interface up).',
        'no connected interface after a failed SET_CLOCK':
            'No interface is reported as connected after the failed clock setting.',
        'a hello without a serial is rejected - rfd.conf names the serial (#17)':
            "The gateway greets without a serial number while rfd's configuration names one: rfd must refuse the gateway instead of talking to an unknown device.",
        'rejected with a configured serial': 'rfd logs the rejection and never completes the connection.',
        'the status file is named after the configured serial, not the spelling the gateway reports (#17)':
            "rfd writes the gateway's connection status into a file the web interface reads. The file must be named after the serial as configured, even when the gateway spells it in other letter case, and be rewritten on a reconnect.",
        'one file, under the configured serial, rewritten on the reconnect':
            'Only the file with the configured spelling exists, and a reconnect updates it.',
        'AES: port 2001 names another gateway than port 2000 - rfd rejects the keepalive connection until it matches (#17)':
            "The gateway's second (keepalive) channel claims to be a different gateway. rfd must refuse that channel until it names the configured serial again.",
        'the keepalive port checks the serial':
            'The keepalive connection to the wrong gateway is refused and never completed.',
        'search by serial: after a drop rfd looks for the configured serial, not the reported spelling (#17)':
            'rfd finds its gateway on the network by serial number. After a connection drop it must search for the serial as configured, not as the gateway last spelled it.',
        'the reconnect searches for the configured serial':
            'The network search after the drop asks for the configured spelling.',
        "AES: the gateway's messages split across TCP segments and gathered into one - the init, the keepalives and a switch work (6c757603)":
            'The gateway sends its messages cut into pieces and several messages in one piece, as a slow network does. rfd must put them together correctly: the setup, the keepalives and switching a device all work, with encryption.',
        "plaintext: the gateway's messages split across TCP segments and gathered into one - the init, the keepalives and a switch work (6c757603)":
            'The same cut and merged gateway messages without encryption: rfd must still assemble them correctly.',
        'AES: rfd started with 900 descriptors open - its sockets get numbers below 1024; the gateway path (e097a3c1) and the RPC server work':
            'A control run: rfd starts with 900 files already open, so its network connections get high numbers that are still below 1024. The gateway connection and the RPC server both work.',
        'AES: rfd started with 1100 descriptors open - its sockets get numbers above 1024; the gateway path (e097a3c1) and the RPC server work':
            'rfd starts with 1100 files already open, so its network connections get numbers above 1024. The gateway connection works since fix e097a3c1; the RPC server should work too (it does not: finding xmlrpc-select-fd).',
        'the gateway path':
            'rfd stays alive, its sockets have the expected numbers, both gateway channels connect and the radio module is set up.',
        'the RPC server answers': 'rfd answers an RPC call.',
        'no sanitizer report': 'The sanitizer build reports no memory error.',
        'two coprocessor system commands at once: each gets its own answer (a duty-cycle query while the module restarts)':
            'Two parts of rfd send a command to the radio module at the same moment: an RPC call asks for the duty cycle while the module restarts. Each command must get its own answer (it does not: finding system-command-slot).',
        'both commands get their own answers':
            'The duty cycle is reported correctly and rfd logs no error for either command.',
    },
    'test/daemon/rfd-lgw-hmlangw.test.js': {
        'rfd with Type = HMLGW2 reaches CONNECTED through hmlangw; the keepalive on 2001 is answered':
            'rfd connects through hmlangw, the LAN-gateway program openccu-lite uses, and brings the radio module online.',
        'a serial that differs only in case is accepted (OpenCCU-Base #17)':
            'A gateway serial number written in other letter case is still recognised.',
        'a gateway with the wrong serial is rejected: rfd logs it and does not come up on it':
            'A gateway with the wrong serial number is refused.',
        'no gateway at start: rfd cannot connect and gives up on the interface':
            'Without a gateway at start, rfd gives up on that interface.',
        'gateway lost and back: CONNECTED false while it is gone, rfd reconnects and re-initialises the module':
            'While the gateway is gone, rfd reports the interface as disconnected; when it returns, rfd reconnects.',
        'reconnect retry: a constant basetimeout (5 s) between attempts when the IP address is configured':
            'rfd retries the connection every five seconds when the gateway address is configured.',
        'hmlangw without -b parks the module in the bootloader while no client is connected':
            'Without its "-b" option, hmlangw keeps the radio module in its boot mode while nobody is connected.',
    },
    'test/daemon/rfd-load.test.js': {
        'every press reached the receiver (the flush-drops-events finding)':
            'Every remote key press during the load should reach the receiver; today rfd discards some input before each command.',
        'rfd load: a burst at 50 % of the air maximum to six switches and one channel, a putParamset in it, remote presses meanwhile - every call answered, every event delivered, the last value wins':
            'Many switching commands at half the radio capacity, with remote presses in between: every call is answered, every event arrives, the last value wins.',
        'rfd load: twenty values to one channel at once over one connection and over XML-RPC - all sent in order, the last one wins':
            'Twenty values for one channel at once are all sent in order, and the last one wins.',
        'rfd load: a sustained run at 50 % of the duty-cycle budget (window scaled to 30 s) - rfd reports the duty cycle the module counts, memory stays flat':
            'A long run at half of the legal airtime: rfd reports the duty cycle the module counts and its memory stays flat.',
        'rfd load: an overload at 200 % of the air maximum with the module refusing past the duty-cycle limit (window 10 s) - RPC stays responsive, events still arrive, rfd recovers':
            'Twice as many commands as the radio can carry, the module refusing beyond the legal limit: rfd stays responsive and recovers.',
        'rfd takes a reported duty cycle of 100 % without reading past its threshold map (the dutycycle-upper-bound finding)':
            'A module reporting 100 % airtime used must not make rfd read past one of its tables; today it does.',
    },
    'test/daemon/rfd-pty-module.test.js': {
        'rfd initialises the simulated module and reports the interface CONNECTED':
            'rfd starts the simulated radio module on a serial line and reports it as connected.',
        'module in the bootloader at start: rfd starts the application and proceeds to CONNECTED':
            'A radio module still in its boot mode is started by rfd and comes online.',
        'a BUSY answer to GET_SERIALNR is retried by rfd (250 ms, twice) and the init completes':
            'A busy answer from the module is retried and the start completes.',
        'rfd survives the hangup': 'rfd keeps running after its serial line hangs up.',
        'no busy loop after the hangup':
            'rfd should not use a full CPU core after the hangup; today it does (read-eof).',
        'listBidcosInterfaces reports the interface as not connected':
            'After the hangup rfd should report the interface as disconnected; today it does not (read-eof).',
        'module lost: the pty hangs up - rfd stays alive without spinning (#115) and reports CONNECTED false (#116)':
            'The serial line to the radio module hangs up: rfd should stay alive, idle, and report the interface as disconnected.',
        'module lost: the pty hangs up (read() == 0) - rfd stays alive, without spinning, and reports CONNECTED false (the read-eof finding)':
            'The serial line to the radio module hangs up: rfd should stay alive, idle, and report the interface as disconnected.',
        'module back: a fresh rfd on a reappeared module reaches CONNECTED again':
            'A radio module that comes back is picked up again by a fresh rfd.',
        'events from the module reach rfd without harm: an unknown device, a duty-cycle event':
            'Telegrams from an unknown device and a duty-cycle report from the module are handled without harm.',
        'frame fuzzing: random frames and garbage on the pty do not crash rfd (seeded)':
            'Random frames and garbage on the serial line must not crash rfd.',
    },
    'test/daemon/rfd-rpc-robustness.test.js': {
        '#138: a nested system.multicall is refused with a fault and rfd stays up; a flat 1000-entry multicall works':
            'A deeply nested multicall, which used to overflow the stack, is refused; a long flat one still works.',
        '#140: malformed BIN-RPC requests get a fault or a closed connection, never a crash':
            'Broken binary requests with impossible length fields get an error or a closed connection, never a crash.',
        'a well-formed raw BIN-RPC request gets a BIN-RPC response':
            'A correct binary request, built by hand, gets a correct answer.',
        'hostile XML-RPC: a deeply nested value tree and a truncated body do not crash or wedge rfd':
            'A deeply nested or cut-off XML request does not crash or block rfd.',
        '#27: a receiver that disappears does not take rfd down; another receiver keeps being served':
            'An event receiver that vanishes does not take rfd down, and the others keep getting their events.',
    },
    'test/daemon/rfd-rpc.test.js': {
        'rfd without any [Interface] does not start: "No BidCoS-Interface available", exit 0':
            'Without a radio interface configured, rfd refuses to start and says why.',
        'rfd serves its RPC methods over BIN-RPC and XML-RPC on the same port':
            'rfd answers both the binary and the XML remote protocol on one port.',
        'init registers a receiver: rfd asks it for its methods and calls listDevices/newDevices on it':
            'A program registering for events is asked what it supports and then told about the devices.',
        'init with an empty id deregisters the receiver and rfd stays up (the double-join finding under ASan)':
            'Unregistering an event receiver must not crash rfd; under the memory checker it does today.',
        'init with an empty id deregisters the receiver and rfd stays up':
            'Unregistering an event receiver must not crash rfd.',
        'a getValue on an unknown address faults, rfd stays up':
            'Asking for a value of a device that does not exist gives an error, nothing worse.',
    },
    'test/daemon/rfd-sweep.test.js': {
        'method sweep: system.listMethods of rfd is the dispatcher table of its source (a method added or removed upstream shows here)':
            'The list of methods rfd reports matches the method table in its source code.',
        'method sweep: every rfd method with valid, missing, extra and wrong-typed arguments; rfd stays up, no sanitizer report':
            'Every method of rfd is called with correct, missing, extra and wrongly typed arguments; rfd must answer each call and stay up.',
        'device-type sweep: one virtual instance of every rftypes type; descriptions, paramsets and values of every device and channel':
            'One instance of every radio device type is created and every description, setting and value is read.',
        'metadata methods with a missing argument fault, rfd stays up, no sanitizer report (the metadata-args finding)':
            'Calling the metadata methods with an argument missing should give an error; under the memory checker it shows a use-after-free today.',
        'a device type with type_conversion_string_unsigned_integer (HM-OU-LED16) is instantiated without a sanitizer report (the string-uint-conversion finding)':
            'Creating an HM-OU-LED16 should be clean; under the memory checker it shows a dangling pointer today.',
    },
    'test/daemon/rfd-switch.test.js': {
        'pairing: install mode, the device announces itself, rfd configures it and reports newDevices':
            'A simulated switch is paired: install mode on, the switch announces itself, rfd configures it and announces it to the receiver.',
        'a set and its acknowledgement: setValue STATE true switches the device, ACK_STATUS becomes the event':
            'Switching on: the command reaches the switch, its confirmation becomes the new state.',
        'a status report from the device becomes an event; rfd acknowledges it':
            'A status report the switch sends on its own becomes an event and is acknowledged.',
        'UNREACH: a silent device fails the set, UNREACH and STICKY_UNREACH go up; the device returns, UNREACH goes down':
            'A switch that stops answering is marked unreachable, and cleared again when it comes back.',
        'CONFIG_PENDING: a MASTER parameter for a silent device stays pending and is delivered when it answers':
            'A setting for a silent switch stays pending and is delivered once it answers again.',
        'duty cycle: the module reports it, rfd shows it; a send refused for duty cycle faults and marks the device unreachable':
            "The module's airtime use is shown by rfd; a command refused for lack of airtime fails cleanly.",
        'the same events on an XML-RPC receiver (http://): newDevices and STATE after a set':
            'An XML-RPC event receiver gets the same announcements and events.',
    },
    'test/daemon/rfd-two-interfaces.test.js': {
        'two interfaces: both listed and connected, one default, setInterfaceClock reaches both modules':
            'rfd with a radio module and a LAN gateway side by side: both are online and both get the clock.',
        'a device is paired through the interface that hears it better; rssiInfo has both; setBidcosInterface moves it':
            'A switch is paired through the interface that receives it better, and can be moved to the other by hand.',
        'roaming: a better copy on the other interface moves the device after 150 ms, not within 300 ms of a send':
            'With roaming on, a device moves to the interface that hears it better - but not right after a command was sent to it.',
        'setBidcosInterface with an interface that does not exist is refused (finding unknown-interface)':
            'Moving a device to an interface that does not exist should be an error; today rfd accepts and stores it.',
        'one interface lost: devices on the other carry on, a roaming device is taken over':
            'When one interface disappears, devices on the other keep working and a roaming device is taken over.',
        'duty-cycle bands: an event when a band changes, none inside a band, per interface; downwards with hysteresis':
            'Each interface reports its airtime use in steps; an event is sent only when the step changes.',
    },
    'test/daemon/rfd-wakeup.test.js': {
        'a wake-up device: a MASTER write stays pending, rfd asks the module to wake the device, the WOKEN_UP event delivers it':
            'A setting for a battery device that sleeps waits until the device next transmits; then the module keeps it awake and rfd delivers the setting.',
        'the wake-up queue: a command to a sleeping device is queued, ten deep with the oldest dropped, and sent after WOKEN_UP':
            'Commands to a sleeping device wait in a queue of ten (older ones are dropped) and go out when it wakes.',
        'a lazy-config device: the wake-up request carries the lazy-config flag, the configuration arrives after its next telegram':
            'A device with "lazy" configuration gets its settings after its next transmission too, with the flag the module needs.',
        'deferred delete: deleteDevice with DEFER on a sleeping device waits for its wake-up; abortDeleteDevice cancels it':
            'Deleting a sleeping device waits for it to wake up; the deletion can be cancelled before that.',
        'a burst device: the first send is a burst, the next within 1.8 s is not, a missed one is retried as a burst':
            'A device that only listens to long wake-up transmissions gets one; the next command right after does not need it, and a missed one is retried with it.',
    },
    'test/daemon/rfd-serial-errors.test.js': {
        'a persistent ENODEV on the serial device: rfd lives, logs once, does not spin, reports CONNECTED false':
            "The radio module's serial device keeps failing with ENODEV, as a stale /dev/mmd_bidcos does after a multimacd restart. A small test shim makes the read fail; rfd must survive, log it once, stay idle and report the interface as disconnected.",
        'rfd survives the failing read()': 'rfd keeps running when reading from the serial device fails.',
        'one error line for the whole streak, no busy loop':
            'rfd logs the error once for the whole failure streak and does not use the CPU while it lasts.',
        'listBidcosInterfaces reports CONNECTED false, RPC keeps answering':
            'While reading keeps failing the interface is reported as disconnected, and rfd still answers RPC calls.',
        'EIO for a while, then the module answers again: CONNECTED goes false and back to true, events arrive':
            'The serial device fails with EIO for a while, as an unplugged USB adapter does, then works again: rfd reports the interface as disconnected, then as connected, and the next message from the module arrives.',
        'rfd survives': 'rfd keeps running through the read errors.',
        'the module is heard again after the error':
            'A message the module sends after the read errors reaches rfd, so its receive path still works.',
        'CONNECTED false during the streak, true after the next good read':
            'The connection state follows the device: disconnected while reads fail, connected again after the first successful read.',
        'EINTR on read(): no error line, CONNECTED stays true':
            'A read interrupted by a signal (EINTR) is not an error: rfd logs nothing and the interface stays connected.',
        'EINTR is not an error': 'No error line, rfd alive and the interface connected after an interrupted read.',
        'a failing select(): handled like a failing read() - alive, one line, no spin':
            'Waiting for data on the serial device fails: rfd treats it like a failed read - alive, one log line, no busy loop.',
        'alive, one select() line, no busy loop': 'rfd survives, logs the failure once and stays idle.',
    },
    'test/daemon/udp-search.test.js': {
        'rfd: HMLGW2 by serial only - the UDP identify and runtime-IP requests, then the gateway on 2000/2001':
            'rfd finds a LAN gateway by its serial number on the network and connects to it.',
        'hs485d: -g -s <serial> - the search over UDP, then the HMW-LGW on port 1000 and a device on the bus':
            'hs485d finds a wired LAN gateway by its serial number on the network and connects to it.',
    },
});

/** Removes one trailing " (…)" group from a test name. */
function withoutSuffix(name) {
    const m = /^(.*\S)\s+\([^()]*\)$/.exec(name);
    return m ? m[1] : null;
}

/**
 * The description of a test, or null.
 * @param {string} file the test file as node:test reports it (test/daemon/x.test.js; an absolute path ending in it
 *   works too)
 * @param {string} name
 */
export function describe(file, name) {
    const key = Object.keys(DESCRIPTIONS).find((f) => file === f || (file || '').endsWith(`/${f}`));
    const entries = key ? DESCRIPTIONS[key] : null;
    if (!entries) {
        return null;
    }
    for (let n = name; n; n = withoutSuffix(n)) {
        if (entries[n]) {
            return entries[n];
        }
    }
    return null;
}
