# hm-radio-simulator

[:uk: English README](README.en.md)

[![CI](https://github.com/hobbyquaker/hm-radio-simulator/actions/workflows/ci.yml/badge.svg)](https://github.com/hobbyquaker/hm-radio-simulator/actions/workflows/ci.yml)
[![Testbericht](https://img.shields.io/badge/Testbericht-GitHub%20Pages-2ea44f)](https://hobbyquaker.github.io/hm-radio-simulator/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> [!CAUTION]
> hm-radio-simulator ist in Entwicklung. Die Stufen 0 bis 1b stehen, die simulierten Geräte noch nicht.

hm-radio-simulator ist ein simuliertes Homematic-Funkmodul und eine Testsuite für die Funk-Daemons der CCU:
**`rfd`** (BidCoS-RF) und **`hs485d`** (Homematic Wired), später möglicherweise auch **`multimacd`**. Die Daemons
werden aus [OpenCCU-Base](https://github.com/OpenCCU/OpenCCU-Base) gebaut, in einem Docker-Container gestartet und
über ihre XML-RPC- und BIN-RPC-Schnittstellen getestet, ohne dass ein Funkmodul im Raum sein muss. Die Tests laufen
bei jedem Push auf GitHub Actions.

[hm-simulator](https://github.com/hobbyquaker/hm-simulator) spielt die Schnittstellenprozesse der CCU gegenüber
ihren Clients. hm-radio-simulator spielt in die andere Richtung: die **Hardware** gegenüber den echten Daemons. Das
ist ein RPI-RF-MOD bzw. HM-MOD-RPI-PCB an einer seriellen Schnittstelle, ein LAN-Gateway (HM-LGW) über TCP oder ein
Wired-LAN-Gateway (HMW-LGW) über TCP.

## Warum

rfd, hs485d und multimacd haben in OpenCCU-Base bisher keine Tests: Die CI dort baut die Daemons, prüft aber nicht,
was sie tun. Gleichzeitig ändern sich gerade viele Teile davon. hm-radio-simulator soll solche Änderungen prüfbar
machen: Startet rfd mit einem Funkmodul? Übersteht er, wenn das Modul weg ist und wiederkommt? Was macht ein
kaputter BIN-RPC-Request? Und wie verhält sich eine neue Version im Vergleich zur alten?

## Was getestet wird

- **Die RPC-Schnittstelle von rfd:** Methodenliste über BIN-RPC und XML-RPC auf demselben Port, `listDevices`,
  `listBidcosInterfaces`, `init` mit einem Event-Empfänger. Dazu die Messung, dass rfd 3.89.11 ohne konfiguriertes
  Interface gar nicht startet ("No BidCoS-Interface available"), weshalb auch diese Tests mit dem simulierten
  Funkmodul laufen.
- **Robustheit der RPC-Schnittstellen:** verschachteltes `system.multicall`
  ([#138](https://github.com/OpenCCU/OpenCCU-Base/pull/138)), fehlerhafte BIN-RPC-Requests
  ([#140](https://github.com/OpenCCU/OpenCCU-Base/pull/140)), feindliches XML-RPC, ein Event-Empfänger, der
  verschwindet ([#27](https://github.com/OpenCCU/OpenCCU-Base/pull/27)), jeweils für rfd und hs485d.
- **rfd mit simuliertem Funkmodul:** die Initialisierung bis `CONNECTED`, das Modul im Bootloader, `BUSY` mit
  Wiederholung, Modul weg ([#115](https://github.com/OpenCCU/OpenCCU-Base/pull/115),
  [#116](https://github.com/OpenCCU/OpenCCU-Base/pull/116)) und wieder da, Events, Fuzzing der Funk-Frames.
- **rfd am LAN-Gateway (HM-LGW):** [hmlangw](https://github.com/OpenCCU/OpenCCU/tree/master/buildroot-external/package/hmlangw)
  vor dem simulierten Modul, rfd mit `Type = HMLGW2` - das ist auch der HM-LGW-Modus von openccu-lite. Die
  Initialisierung bis `CONNECTED`, das Keepalive auf Port 2001, eine Seriennummer in anderer Schreibweise
  ([#17](https://github.com/OpenCCU/OpenCCU-Base/pull/17)), eine falsche Seriennummer, kein Gateway beim Start,
  Gateway weg und wieder da (rfd meldet `CONNECTED = false`, verbindet neu und initialisiert das Modul erneut), der
  Takt der Wiederverbindung, hmlangw ohne `-b` (das Modul wird ohne Client im Bootloader geparkt).
- **Ein simulierter Schaltaktor (HM-LC-Sw1-Pl) hinter dem Modul,** aus der `rftypes`-Beschreibung, die auch rfd liest:
  Anlernen im Anlernmodus (Ansage des Geräts, rfd schreibt Liste 0 mit der Zentralenadresse, tauscht den AES-Schlüssel
  aus, liest die Listen und Peers zurück, meldet `newDevices`), Schalten mit `ACK_STATUS` und dem Event dazu,
  eine Statusmeldung des Geräts, `UNREACH`/`STICKY_UNREACH` samt Servicemeldung bei einem stummen Gerät und das
  Zurückkommen, `CONFIG_PENDING` für eine Konfiguration, die erst nach der Rückkehr ankommt, der Duty Cycle, die
  Events über BIN-RPC und XML-RPC. Jeder Test schreibt die Telegramme der Luftstrecke als Spur in den Bericht, sodass
  sich die OpenCCU-Base-Versionen vergleichen lassen.
- **Fuzzing der Parser** mit libFuzzer: die BIN-RPC- und XML-RPC-Deserialisierung, der Request-Dispatcher mit
  `system.multicall` und `xmlParser`.

Die Daemons laufen in zwei Varianten: als normaler Build und mit AddressSanitizer/UndefinedBehaviorSanitizer. Ein
Regressionstest für einen Fehler, dessen Fix in der gewählten OpenCCU-Base-Version noch fehlt, läuft als `todo`.
Der Lauf zeigt dann, was passiert, ohne rot zu werden. Gegen `3.89.11` betrifft das #115, #116, #138 und #140
sowie einen Fund dieser Suite ohne Issue bisher, `double-join`: Unter AddressSanitizer bricht rfd beim Abmelden eines
Event-Empfängers (`init(url, '')`) ab, weil der Thread des Dispatchers nach einem expliziten Stop im Destruktor ein
zweites Mal gejoint wird (libelvutils `Actor::Stop()`); der normale Build merkt davon nichts. Der zweite Fund ohne Issue ist `read-eof`: Ein Pseudo-Terminal, dessen Master
verschwunden ist, beantwortet `read()` mit 0 (Dateiende), was #115/#116 nicht als Fehler behandeln (sie behandeln -1:
`ENODEV` von einem veralteten `/dev/mmd_bidcos`, `EIO` von einem abgezogenen Adapter). rfd auf `main` dreht nach dem
Verlust des Moduls deshalb weiter mit 100 % CPU und meldet `CONNECTED = true`. Gegen `main` bleiben `double-join` und
`read-eof`.

## Wie es funktioniert

- Das Docker-Image holt OpenCCU-Base in einer wählbaren Version (Tag oder Commit, Standard `3.89.11`) und baut daraus
  rfd, hs485d, libXmlRpc und libxmlparser. Von OpenCCU-Base liegt nichts in diesem Repository.
- Das simulierte Funkmodul (`lib/`, Node.js) spricht das serielle Protokoll des Moduls: Framing mit CRC, die
  System- und BidCoS-Befehle, Adresse, Schlüssel, Peers, Uhrzeit, Duty Cycle. Es hängt über ein Pseudo-Terminal
  (`socat`) als Gerätedatei am Daemon. rfd öffnet es wie einen echten `ComPortFile`.
- Hinter dem Modul liegt eine virtuelle Luftstrecke mit simulierten Geräten. Ein Gerät wird von derselben
  `rftypes`-XML-Datei getrieben, aus der rfd seine Telegramme baut (ein kleiner Leser dafür, keine Abhängigkeit); dazu
  kommt das generische BidCoS-Protokoll (Anlern-Ansage, die Konfigurationslisten, Peer-Listen, Statusabfragen,
  Quittungen) und ein dünnes Verhalten je Gerätetyp, bisher der Schaltaktor. Die erste Antwort eines Geräts meldet das
  Modul als Quittung (`TELEGRAM_SENT_RECVD_ACK`), weitere als Events; ein stummes Gerät endet in `SEND_FAILED`.
- Das LAN-Gateway ist hmlangw selbst (MIT, beim Bau des Images aus dem OpenCCU-Repository geholt, Commit
  festgepinnt): Es lauscht auf den HM-LGW-Ports 2000 und 2001 und reicht die Frames an das simulierte Modul auf dem
  Pseudo-Terminal durch. Zwei Eigenheiten von hmlangw 1.1.1 zeigen sich dabei: Es startet seine Threads mit
  `SCHED_RR`, was im Container `--cap-add SYS_NICE` braucht (sonst endet es still mit Exit-Code 1), und seine
  Debug-Ausgabe (`-D`) stürzt in `sendEnterBootloader()` ab, weil die `fprintf`-Argumente vertauscht sind; die Suite
  nutzt `-D` deshalb nur zusammen mit `-b`. Gemessen an rfd 3.89.11: Mit konfigurierter `IP Address` fragt rfd die
  Seriennummer nicht vom Modul ab, `CONNECTED` wird schon mit dem Text-Vorspiel wahr (die Modul-Initialisierung folgt
  erst), und der Wiederverbindungsversuch kommt konstant alle 5 s (`basetimeout`) plus 2 s Hello-Wartezeit; das
  Anwachsen auf etwa 60 s gilt nur für die Suche per Seriennummer.
- Das eigentliche Funk-Timing (Frames in der Luft, ACK-Fenster, Burst, CSMA/CA, Duty Cycle) passiert in der Firmware
  des Moduls. Der Daemon sieht davon nur Statusmeldungen, auf die er sekundenlang wartet. Die Simulation bildet das
  logisch nach und muss nur die Antwortfenster auf der seriellen Seite einhalten (rfd: 1 s pro Befehl, 4 s bis zum
  Sendestatus; hs485d: 700 ms). Node.js liegt mit unter einer Millisekunde Latenz weit darunter.

```js
import {RadioModule, createPtyModule} from 'hm-radio-simulator';

const module = new RadioModule({serial: 'SIM0000001', mode: 'bootloader'});
await createPtyModule({module, link: '/run/sim/uart0'});
// rfd.conf: [Interface 0] Type = CCU2, ComPortFile = /run/sim/uart0, AccessFile = /dev/null, ResetFile = /dev/null
await module.waitForCommand('SET_RF_ADDRESS');
```

## Ausführen

Was die Daemons braucht, läuft in Docker. Die Unit-Tests des Simulators laufen überall mit Node.js ≥ 22.

```sh
npm ci
npm test                       # Unit-Tests des Simulators
scripts/run-tests.sh           # Image für OpenCCU-Base 3.89.11 bauen, Suite normal und mit ASan
scripts/run-tests.sh --ref main --variants release --fuzz 60
```

Der Container läuft mit `--cap-add SYS_NICE` (für hmlangw, siehe oben); `scripts/run-tests.sh` und die CI setzen das.

Das Image basiert absichtlich auf Debian trixie: Die Sanitizer-Laufzeiten von bookworm (LLVM 14, GCC 12) stürzen auf
Kerneln mit 32 Bit `mmap`-Randomisierung beim Start ab, was wie ein sporadischer Segfault in jedem vierten ASan-Lauf
aussieht; LLVM 19 und GCC 14 aus trixie haben das Problem nicht.

Die Ergebnisse landen in `results/<variante>/` (JUnit, Logs der Daemons, Sanitizer-Berichte), Fuzzing-Funde in
`results/fuzz/artifacts/`. Die CI (`.github/workflows/ci.yml`) testet `3.89.11` und `main` in beiden Varianten und
lässt jeden Fuzzer 60 s laufen.

## Testbericht

Jeder CI-Lauf schreibt eine Markdown-Übersicht in seine Zusammenfassung auf GitHub (je Job, und für den ganzen Lauf im
Job "test report"). Der Lauf auf `main` veröffentlicht dazu einen HTML-Bericht auf GitHub Pages:
**<https://hobbyquaker.github.io/hm-radio-simulator/>** - die OpenCCU-Base-Versionen nebeneinander (`3.89.11` und
`main`, jeweils normal und mit ASan), je Test der Ausgang, die Dauer und die Diagnosen, dazu die Fuzzing-Läufe und
ein Verlauf der letzten 20 Läufe (`runs/<id>/`). So liest man ihn:

- **regression** - der Test pinnt einen behobenen Fehler in OpenCCU-Base fest und verlinkt den Pull Request und den
  Merge-Commit; auf einer Version vor dem Fix läuft er als **todo** (bekannt kaputt, der Lauf bleibt grün);
- **known bug** - ein Fund dieser Suite ohne Fix upstream (`double-join`, `read-eof`); verlinkt das Issue oder,
  solange es keins gibt, den Abschnitt oben;
- **behaviour** - ein gemessenes Verhalten der Daemons; **fuzz** - die geseedeten Fuzzing-Tests der Suite.

Die Daten dahinter liegen als `report.json` neben der Seite. Nichts davon ist im Repository eingecheckt; der Bericht
entsteht aus den Artefakten des Laufs (`scripts/report.mjs`), lokal mit `npm run report` nach `scripts/run-tests.sh`.

## Roadmap

- ✅ **Stufe 0:** Docker-Image mit den Daemons aus OpenCCU-Base, RPC-Tests der Daemons, Regressionstests
- ✅ **Stufe 0:** libFuzzer für libXmlRpc und libxmlparser
- ✅ **Stufe 1a:** simuliertes RPI-RF-MOD an einem Pseudo-Terminal: Initialisierung, Modul weg und wieder da,
  Frame-Fuzzing
- ✅ **Stufe 1b:** LAN-Gateway über
  [hmlangw](https://github.com/OpenCCU/OpenCCU/tree/master/buildroot-external/package/hmlangw) vor dem simulierten
  Modul, ohne Verschlüsselung
- ✅ **Testbericht:** Markdown-Übersicht in jedem CI-Lauf und ein HTML-Bericht auf GitHub Pages mit Verlauf, Links zu
  den Upstream-Fixes und -Issues, den OpenCCU-Base-Commits je Version und den Fuzzing-Ergebnissen
- 🕵️ **Stufe 2:** ein simulierter Schaltaktor aus den `rftypes`-Beschreibungen: Anlernen, Schalten mit ACK, Status,
  UNREACH, CONFIG_PENDING, Duty Cycle; Vergleich alte gegen neue OpenCCU-Base-Version
- 📥 **Stufe 3:** eine Fernbedienung, das LAN-Gateway mit AES-Handshake und Reconnects, AES-gesicherte Geräte
- 📥 **Stufe 4:** hs485d gegen ein simuliertes Wired-LAN-Gateway mit einem Wired-Aktor
- 🤷 **Stufe 5:** multimacd in einer VM mit `eq3_char_loop` und dem Protokoll des Dual-Coprozessor-Moduls
- 📥 Kalibrierung des Modul-Timings an einem echten RPI-RF-MOD
- 🏗️ **Testbericht:** die vier Ergebnisspalten in jeder Tabelle rechtsbündig und gleich breit
- 📥 **Testbericht:** Code-Abdeckung von rfd und hs485d durch die Suite, im Bericht
- 📥 **Suite bei jedem neuen OpenCCU-Base-Commit:** alle 15 Minuten den Stand von `main` abfragen und bei einem neuen
  Commit die Suite genau dafür laufen lassen, mit Hinweis im Bericht
- 🤷 **Mehr Daemon-Tests:** RPC- und Gerätetyp-Durchläufe, Persistenz, Verknüpfungen und Wakeup, Firmware, hs485d,
  weitere Fuzz-Ziele

✅ erledigt · 🕵️ gebaut, in Prüfung · 🏗️ in Arbeit · 📥 eingereiht · ☑️ bereit zur Umsetzung · 🤷 noch zu klären · 💤 später

## Credits und Lizenzen

- Dieses Repository: MIT, Sebastian Raff.
- [OpenCCU-Base](https://github.com/OpenCCU/OpenCCU-Base) (OpenCCU-Projekt, eQ-3 AG): die getesteten Daemons und
  ihre Gerätebeschreibungen, beim Bau des Images geholt. HMSL 2 für die Daemons und Beschreibungen, LGPL 2.1 für
  libXmlRpc und libxmlparser. Nichts davon ist Teil dieses Repositorys.
- [ReGaHss-Test](https://github.com/OpenCCU/ReGaHss-Test) (Jens Maus, Sebastian Raff; MIT): das Vorbild für Image
  und Suite, dieselbe Idee für die ReGaHss.
- [hmlangw](https://github.com/OpenCCU/OpenCCU/tree/master/buildroot-external/package/hmlangw) (Oliver Kastl,
  Jens Maus, Jérôme Pech; MIT): das LAN-Gateway der Suite, beim Bau des Images geholt und gebaut.
- `00_HMUARTLGW.pm` aus [FHEM](https://fhem.de) (GPL) und [Homegear](https://github.com/Homegear) (GPL): als
  Dokumentation des Modulprotokolls gelesen, kein Code übernommen.
- [binrpc](https://github.com/hobbyquaker/binrpc) und
  [homematic-xmlrpc](https://github.com/hobbyquaker/homematic-xmlrpc) (MIT): die RPC-Clients der Tests.
- [socat](http://www.dest-unreach.org/socat/) (GPL, im Image): das Pseudo-Terminal.
