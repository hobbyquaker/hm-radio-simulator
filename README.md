# hm-radio-simulator

[:uk: English README](README.en.md)

[![CI](https://github.com/hobbyquaker/hm-radio-simulator/actions/workflows/ci.yml/badge.svg)](https://github.com/hobbyquaker/hm-radio-simulator/actions/workflows/ci.yml)
[![Testbericht](https://img.shields.io/badge/Testbericht-GitHub%20Pages-2ea44f)](https://hobbyquaker.github.io/hm-radio-simulator/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

hm-radio-simulator ist ein simuliertes Homematic-Funkmodul und eine Testsuite für die Funk-Daemons der CCU:
**`rfd`** (BidCoS-RF) und **`hs485d`** (Homematic Wired), später möglicherweise auch **`multimacd`**. Die Daemons
werden aus [OpenCCU-Base](https://github.com/OpenCCU/OpenCCU-Base) gebaut, in einem Docker-Container gestartet und
über ihre XML-RPC- und BIN-RPC-Schnittstellen getestet, ohne dass ein Funkmodul im Raum sein muss. Die Tests laufen
bei jedem Push auf GitHub Actions.

Simuliert wird die **Hardware** gegenüber den echten Daemons: ein RPI-RF-MOD bzw. HM-MOD-RPI-PCB an einer seriellen
Schnittstelle, ein LAN-Gateway (HM-LGW) über TCP oder ein Wired-LAN-Gateway (HMW-LGW) über TCP.

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
  Wiederholung, Modul weg und wieder da, Events, Fuzzing der Funk-Frames. Der Verlust des Moduls endet hier mit
  `read()` = 0 (Dateiende, der Fund `read-eof`).
- **Lesefehler am seriellen Gerät** ([#115](https://github.com/OpenCCU/OpenCCU-Base/pull/115),
  [#116](https://github.com/OpenCCU/OpenCCU-Base/pull/116)): ein kleiner `LD_PRELOAD`-Shim (`shim/hmrs-faults.c`, nur
  Testgerüst, er ändert nichts an rfd) lässt `read()` und `select()` auf dem Gerät des Moduls mit einem gewählten
  `errno` scheitern, wie es ein veraltetes `/dev/mmd_bidcos` (`ENODEV`) oder ein abgezogener Adapter (`EIO`) tut: rfd
  bleibt am Leben, schreibt eine Fehlerzeile je Fehlerserie, dreht nicht durch, meldet `CONNECTED = false` und nach
  dem nächsten gelungenen Lesen wieder `true`; `EINTR` ist kein Fehler; ein scheiterndes `select()` wird wie ein
  scheiterndes `read()` behandelt. Vor #115 (3.89.11) stirbt rfd beim ersten gescheiterten `read()` (SIGSEGV).
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
  Events über BIN-RPC und XML-RPC, der RSSI der Quittung (der Fund `ack-rssi-sign`: das Modul schickt ihn im
  Sendestatus als vorzeichenbehaftetes Byte, rfd liest ihn wie den Betrag im Event). Jeder Test schreibt die Telegramme
  der Luftstrecke als Spur in den Bericht, sodass sich die OpenCCU-Base-Versionen vergleichen lassen.
- **rfd am LAN-Gateway mit AES (`lib/lgw.js`):** ein HM-LGW-Gegenstück in JavaScript mit `Encryption Key`, dem
  `V`-Handshake und AES-128-CFB auf beiden Ports: die Initialisierung durch den verschlüsselten Kanal, ein falscher
  LAN-Schlüssel (rfd meldet `WRONG_KEY` und beendet sich), Klartext, Port 2000 weg, Port 2001 weg, ein stummes
  Keepalive, Gateway weg und wieder da mit falscher Seriennummer im ersten Hello
  ([#13](https://github.com/OpenCCU/OpenCCU-Base/pull/13), [#16](https://github.com/OpenCCU/OpenCCU-Base/pull/16),
  [#17](https://github.com/OpenCCU/OpenCCU-Base/pull/17)), Port 2000 weg, während ein Telegramm unterwegs ist, und
  das Modul stromlos hinter dem Gateway: rfd meldet Geräte und Schlüssel neu an (`restoreConfigToCoprocessor`), die
  AES-Richtlinie je Kanal aber nicht (`aes-republish`).
- **Die Wiederherstellung am LAN-Gateway** ([#13](https://github.com/OpenCCU/OpenCCU-Base/pull/13),
  [#17](https://github.com/OpenCCU/OpenCCU-Base/pull/17)): eine Wiederherstellung des Coprozessors, die nach dem
  Reconnect scheitert (rfd trennt, wartet 5 s und verbindet neu, statt das halb eingerichtete Modul zu benutzen), ein
  Modul, das nach dem TCP-Reconnect nicht antwortet (währenddessen geht kein Telegramm hinaus), ein Neustart des Moduls
  hinter dem Gateway mit drei gescheiterten Versuchen und neuer Verbindung, kein Keepalive-Thread bleibt nach drei
  Reconnects übrig, `SET_CLOCK` scheitert beim Start; ein Hello ohne Seriennummer, die Statusdatei unter der
  konfigurierten Seriennummer, Port 2001 mit fremder Seriennummer, die Suche nach der konfigurierten Seriennummer;
  Nachrichten des Gateways auf mehrere TCP-Segmente verteilt und zusammengefasst (6c757603), Sockets über Deskriptor 1024
  (e097a3c1) - dabei fiel `xmlrpc-select-fd` auf - und zwei Systembefehle aus zwei Threads gleichzeitig
  (`system-command-slot`).
- **AES-gesicherte Geräte und eine Fernbedienung (HM-RC-4 aus `rf_rc.xml`):** der Schlüsseltausch beim Anlernen,
  `AES_ACTIVE` setzt die Kanal-Authentifizierung im Modul (`AUTHENTICATION_ON`), ein Schaltbefehl läuft durch
  Challenge-Response (die Luftstrecke rechnet, was sonst die Modul-Firmware tut: `ACK_W_AES_CHALLENGE`,
  `AES_SOLUTION`, signiertes ACK), ein Gerät mit anderem Schlüssel fällt durch (`UNREACH`); die Fernbedienung mit
  `PRESS_SHORT`/`PRESS_LONG`, deren Tasten rfd ab Werk authentifizieren lässt (`aes_default`), die Konfiguration
  eines schlafenden Geräts (`CONFIG_PENDING`, geliefert beim nächsten Druck auf die Anlerntaste), eine
  Direktverknüpfung zwischen Fernbedienung und Aktor (`addLink`, Peer-Listen auf beiden Seiten, `getLinks`, das
  LINK-Paramset als Liste 3 im Aktor, `removeLink`).
- **Mit CBC-MAC signierte Events** ([#4](https://github.com/OpenCCU/OpenCCU-Base/pull/4)): Kein Kanal der
  `rftypes` von OpenCCU-Base trägt `aes_cbc="true"`, deshalb läuft rfd hier auf einer Kopie, in der der Schaltkanal
  des HM-LC-Sw1-Pl das Attribut bekommt; der Aktor signiert seine Statusmeldung mit 24-Bit-Zähler und 4-Byte-MIC.
  Richtig signiert mit steigendem Zähler kommt sie an, ein falscher MIC und ein alter Zähler fallen durch, der Zähler
  übersteht einen Neustart (`aes_cbc_cnt` in der Gerätedatei); ein Gerät auf dem Standardschlüssel (Index 0) wird
  nicht geprüft, sein Wert gilt aber als nicht authentifiziert (rfd fragt das Gerät).
- **Link-Register aus den `rftypes`:** beim HM-OU-CFM-TW landet `LONG_ACT_TYPE` einer Direktverknüpfung in Register
  0xA4 und `SHORT_ACT_TYPE` bleibt in 0x24 ([#63](https://github.com/OpenCCU/OpenCCU-Base/pull/63); vorher
  überschrieb die lange Aktion die kurze).
- **Geräte, die schlafen:** ein Wakeup-Gerät (HM-PB-2-WM55, `CONFIG,WAKEUP`), ein Gerät mit Lazy Config (HM-RC-4-2),
  ein Bewegungsmelder (HM-Sec-MDIR) und ein Burst-Gerät (HM-LC-Sw1-Ba-PCB, `BURST`). Ein Paramset für ein schlafendes
  Wakeup-Gerät versucht rfd einmal sofort, dann bleibt es offen (`CONFIG_PENDING`), und rfd bittet das Modul, das
  Gerät zu wecken (`ADD_LINK_PEER` mit Wakeup-Byte, bei `LAZY_CONFIG` auch mit dem Lazy-Byte); das nächste Telegramm
  des Geräts kommt mit dem `WOKEN_UP`-Flag des Moduls, und rfd liefert die Konfiguration nach und nimmt die Bitte
  zurück. Befehle an ein schlafendes Gerät stellt rfd in eine Warteschlange von zehn (zwölf Befehle: die zwei ältesten
  fallen mit einer Warnung heraus, zehn gehen nach dem Aufwachen raus). `deleteDevice` mit `DEFER` wartet auf das
  Aufwachen, `abortDeleteDevice` bricht es ab. Ein Burst-Gerät bekommt sein erstes Telegramm als Burst, das nächste
  innerhalb von 1,8 s ohne, und ein verpasster Versuch wird als Burst wiederholt; antwortet es gar nicht, folgt
  `UNREACH`.
- **Zwei Interfaces:** ein RPI-RF-MOD am Pseudo-Terminal und ein HM-LGW (mit LAN-Schlüssel) auf einer zweiten
  Loopback-Adresse, beide an derselben Luftstrecke, jedes hört ein Gerät mit eigener Feldstärke. Beide in
  `listBidcosInterfaces`, `setInterfaceClock` erreicht beide Module; ein neues Gerät wird über das Interface angelernt,
  das es besser hört (auch wenn das nicht das Standard-Interface ist); `rssiInfo` mit beiden Werten;
  `setBidcosInterface` zieht ein Gerät um (`ADD_LINK_PEER` am neuen, `REMOVE_LINK_PEER` am alten Modul). Roaming: kommt
  die bessere Kopie eines Telegramms als zweite an, wechselt rfd nach 150 ms, nicht innerhalb von 300 ms nach einem
  Senden; kommt sie als erste an, wechselt rfd erst mit dem nächsten Senden. Fällt ein Interface aus, laufen die Geräte
  am anderen weiter, und ein Gerät mit Roaming wird übernommen. Die Duty-Cycle-Stufen (0/40/65/80/90/95/98/99 %): ein
  Event je Stufenwechsel, keins innerhalb einer Stufe, je Interface, abwärts mit Hysterese.
- **hs485d am Wired-LAN-Gateway (HMW-LGW, `lib/hmwlgw.js`)** mit einem simulierten Schaltaktor (HMW-LC-Sw2-DR aus
  den `hs485types`-Beschreibungen des Images) am Bus (`lib/wired.js`): der Verbindungsaufbau mit demselben Vorspiel wie
  beim HM-LGW (auch verschlüsselt mit `-k`), das Keepalive `K` alle 20 s, die Gerätesuche (`D` → `d`/`c`, dann `h`/`v`/`n`
  und die EEPROM-Belegung `E`), Schalten mit `x` und dem `i`-Event, Lesen mit `S`, Tastendrücke als `PRESS_SHORT`/
  `PRESS_LONG` (ein wiederholter Zähler ohne SYN wird verworfen), die Ansage eines neuen Geräts (`A`), Paramsets im
  EEPROM (`W`/`R`), eine Verknüpfung Taste → Aktor, ein stummes Gerät (`a 01`, `UNREACH`/`STICKY_UNREACH`), der
  Keepalive-Ausfall mit Wiederverbindung und der Neustart mit den Gerätedateien, darunter ein Typ-Byte ≥ 0x80
  ([#9](https://github.com/OpenCCU/OpenCCU-Base/pull/9)) - und nach dem Neustart der Wartungskanal, der dem neu
  gefundenen Gerät fehlt (`wired-maintenance`).
- **Die UDP-Gerätesuche** (libLanDeviceUtils, `lib/eq3udp.js`): ein simuliertes eQ-3-LAN-Gerät beantwortet die
  Suche auf UDP 43439 - rfd findet so ein nur per Seriennummer konfiguriertes HM-LGW, hs485d sein HMW-LGW (`-s`), und
  hs485d sucht das Gateway bei jeder Wiederverbindung so, auch wenn es mit `-h` gestartet wurde.
- **Die Durchläufe (Sweeps):** jede RPC-Methode von rfd (52) und hs485d (25) mit gültigen, fehlenden, überzähligen
  und falsch typisierten Argumenten (neun Werte je Position: Integer-Ränder, Double, Boolean, ein langer String,
  Array, Struct). `system.listMethods` muss der Dispatcher-Tabelle aus dem Quelltext entsprechen, die das Image beim
  Bau liest (`scripts/method-table.mjs`); eine upstream hinzugefügte oder entfernte Methode fällt so auf. Dazu je ein
  Gerät jedes Typs aus `rftypes` (341 von 343, ohne Funk über `addVirtualDeviceInstance`, die Ansage aus den
  Bedingungen des Typs gebaut) und jedes Typs aus `hs485types` (15, auf dem simulierten Bus gesucht), von dem
  Gerätebeschreibung, Paramset-Beschreibungen, Paramsets und Werte jeder Adresse abgefragt werden. Der Daemon muss
  alles überstehen, ohne Sanitizer-Bericht. Jede Antwort wird kurz festgehalten; der Testbericht vergleicht die
  Antworten benachbarter Versionen (älteres Tag → neueres Tag → `main`) und die des zuletzt geprüften `main`-Commits mit dem
  aktuellen (_Differential_).
- **Der Empfänger-Vertrag** (rfd und hs485d, beide über libhsscomm): drei Empfänger gleichzeitig, jeder mit seiner
  eigenen ID synchronisiert; `ping` schickt `PONG` an alle, 20 Events kommen bei jedem in Reihenfolge an. Beim `init`
  entscheidet die `listDevices`-Antwort des Empfängers: Unbekanntes wird gelöscht, eine andere `VERSION` neu
  geschickt, dieselbe ausgelassen. Die Unerreichbar-Regel, gemessen: Zehn fehlgeschlagene Zustellungen in Folge, und
  das elfte Event entfernt den Empfänger samt Eintrag in der Handler-Datei; ein Erfolg setzt die Zählung zurück. Ein
  hängender Empfänger bremst nur sich selbst (die anderen bekommen ihre Events nach rund 20 ms, RPC antwortet sofort).
  Servicemeldungen werden einem später angemeldeten Empfänger nachgeschickt; ein `replaceDevice` erreicht alle
  angemeldeten Empfänger.
- **Neustart, Gerätedateien und Konfiguration:** je ein Gerät jedes `rftypes`-Typs, rfd über seine RPC-Methode
  `exit` sauber beendet (exit(0) in Millisekunden) und neu gestartet - alle Adressen, Typen, Versionen und Kanäle sind
  wieder da (dazu die Team-Geräte der Rauchmelder, die erst das Laden aus der Datei anlegt); dasselbe für jeden
  `hs485types`-Typ. Eine halbierte Gerätedatei wird verworfen, Müll und leere Dateien übergangen, übrig gebliebene
  `.bak`/`.new`-Kopien ignoriert, ein fehlender Kanal neu angelegt. `BidCoS-Address = 0` (der erste Start eines neuen
  Systems): rfd übernimmt die Standardadresse des Moduls und schreibt sie in die Adressdatei; `changeKey` schreibt
  Schlüssel und Index in die Schlüsseldatei, ein Neustart lädt sie; angemeldete Empfänger überstehen den Neustart
  (`XmlRpcHandlersFile`). Die Start-Matrix: fehlende Konfigurationsdatei, unbekannter Interface-`Type`, `Log
Destination` File und None, `UDS File`, ein belegter Port ("Could not bind", Exit-Code 0), zwei Interfaces, die alte
  Coprozessor-Initialisierung, der Sniffing-Modus (`-s`), hs485d mit zusätzlichen Beschreibungen in
  `/etc/config/hs485types`.
- **Ein Empfänger, der sich danebenbenimmt** (rfd und hs485d, Rückrufe über BIN-RPC und XML-RPC): ein Empfänger
  auf Byte-Ebene schließt mitten in der Anfrage, verschwindet, antwortet nie oder liest nicht mehr, antwortet mit
  HTTP-Fehler, Fault, Müll, abgeschnitten, mit falschem Typ, mit mehreren MB, Byte für Byte oder doppelt - der zweite
  Empfänger bekommt seine Events weiter in rund 10 ms, RPC antwortet, das Funkgerät schaltet, Threads und Dateien des
  Daemons sind danach wie vorher. Dazu riesige und ungültige `listDevices`-Antworten beim `init`, 100 Anmeldungen in
  Folge, zwei Empfänger mit einer ID, eine URL ohne Gegenstelle. Zwei Funde: `init-blocks` und
  `async-callback-threads` (siehe unten).
- **Ältere Fixes, die jeder Stand schon hat** (älter als der CMake-Build von OpenCCU-Base, also nie als todo und
  nicht gegen den Stand vor dem Fix beweisbar), festgehalten, damit sie nicht zurückkommen; jeder Test nennt seinen
  Commit: hs485d nennt ein Wired-Gerät ohne Seriennummer `ELV` plus Adresse in Hex (c57eb49f) und einen
  Verknüpfungspartner, den kein Gerät hat, `@` plus Hex, und überspringt Dateien ohne Punkt in seinem
  Geräteverzeichnis (bf7851d1); rfd und hs485d sind mit einem Event an einen trägen XML-RPC-Empfänger
  (`Content-Length: 0`, der Header endet genau am Ende eines Lesevorgangs, eine `<methodResponse>` ohne `<params>`)
  sofort fertig, höchstens ein Wiederholungsversuch, kein Warten auf den Timeout, und jede Anfrage trägt `<params>`
  (fc83bfd4); mit libfaketime an der Uhr des Daemons gibt ein Aufruf an einen Empfänger, der nie antwortet, nach den
  üblichen 10 s auf - über den 2^32-ms-Überlauf der alten 32-Bit-Millisekundenuhr hinweg wie über Sprünge der Uhr um
  +1 h und -1 h (90c666c0). Gemessen: der Timeout folgt der Uhrzeit nicht, der `CLOCK_REALTIME`-Kandidat ist kein
  Fund.
- **`listMethods` stimmt** (rfd und hs485d, BIN-RPC und XML-RPC): jeder gelistete Name ist dem Dispatcher bekannt
  (gefragt über `system.methodHelp`, die harmlosen auch aufgerufen), und kein anderer: alle Namen aus dem Quelltext
  der Daemons (auch nicht registrierte), die des anderen Daemons, Namen anderer Homematic-Schnittstellen,
  Schreibvarianten. Zerstörerische Methoden werden nie aufgerufen. Gemessen auf `3.89.11`: rfd listet 55 und alle 55
  sind aufrufbar, hs485d 28 von 28, kein ungelisteter Name ist aufrufbar (hs485ds nicht registriertes
  `activateLinkParamset` eingeschlossen); `system.methodHelp` kennt `system.multicall` nicht (es steckt in der
  Verbindung), `system.methodSignature` gibt es nicht. Der Testbericht zeigt die Zahlen als Tabelle.
- **Last (rfd):** sechs Schaltaktoren und eine Fernbedienung auf der Luftstrecke mit berechneter Sendezeit. Eine Salve
  mit 50 % des Luft-Maximums (8,3 von 16,7 Befehlen pro Sekunde) mit einem `putParamset` mittendrin und
  Fernbedienungs-Tastendrücken währenddessen: jeder Aufruf beantwortet, jeder Befehl in Reihenfolge in der Luft, jeder
  Tastendruck beim Empfänger (bis auf `flush-drops-events`), der letzte Wert gewinnt. 21 Werte an einen Kanal über BIN-RPC und XML-RPC: alle gesendet,
  nichts zusammengefasst. Ein Dauerlauf mit 50 % des Duty-Cycle-Budgets (Fenster auf 30 s verkürzt): rfd meldet, was
  das Modul zählt, der Speicher bleibt gleich. Eine Überlast mit 200 % und überschrittenem Duty Cycle: RPC antwortet
  weiter, Events kommen an, rfd fängt sich danach. Die Zahlen stehen im Testbericht.
- **Fuzzing der Parser** mit libFuzzer: die BIN-RPC- und XML-RPC-Deserialisierung, der Request-Dispatcher mit
  `system.multicall`, `xmlParser` (auch beim Bearbeiten und Serialisieren geparster Knoten, dazu feste Fälle für die
  Clear-Tags), die seriellen Frames des Funkmoduls und die Coprozessor-Befehle, die das daraus macht, die Frames des
  Wired-LAN-Gateways, die Konfigurationsdateien (`PropertyMap`), Wired-Firmware-Dateien (`Hexfile`),
  Update-Dateien und das JSON von rfd. In der Suite: Telegramme mit verändertem Inhalt von der Adresse eines angelernten
  Geräts (sie erreichen das Gerätemodell), ein Verzeichnis namens `X.dev` und eine leere `.dev` bei rfd und hs485d.
  Drei Funde daraus: `json-substr` (ein `setValue` mit kaputtem JSON beendet rfd), `hexfile-no-data` (eine
  Firmware-Datei ohne Datensatz lässt hs485d abstürzen) und `propertymap-long-line` (eine Konfigurationszeile über 255
  Zeichen: der Daemon startet nie).

Die Daemons laufen in zwei Varianten: als normaler Build und mit AddressSanitizer/UndefinedBehaviorSanitizer; dazu
kommt eine dritte, `coverage`, für die Code-Abdeckung (siehe _Testbericht_). Ein
Regressionstest für einen Fehler, dessen Fix in der gewählten OpenCCU-Base-Version noch fehlt, läuft als `todo`.
Der Lauf zeigt dann, was passiert, ohne rot zu werden. Welche Tests das je Version sind, wird nicht von Hand gepflegt:
`scripts/resolve-refs.mjs` prüft für jeden Upstream-Fix, ob sein Merge-Commit in der Version enthalten ist: als Vorfahre oder, auf einem Fork-Zweig, übernommen (eine Zeile `cherry picked from commit <sha>`, sonst dieselbe Patch-ID). Ein Fix, den es nur im Fork gibt, zählt mit seinem Commit im Fork, bis upstream ihn übernimmt; dann kommt nur der Merge-Commit dazu. Gegen
`3.89.9` und `3.89.11` betrifft das #138 und #140
sowie zwölf Funde dieser Suite ohne Issue bisher. `double-join`: Unter AddressSanitizer bricht rfd beim Abmelden eines
Event-Empfängers (`init(url, '')`) ab, weil der Thread des Dispatchers nach einem expliziten Stop im Destruktor ein
zweites Mal gejoint wird (libelvutils `Actor::Stop()`); der normale Build merkt davon nichts. Der zweite Fund ohne Issue ist `read-eof`: Ein Pseudo-Terminal, dessen Master
verschwunden ist, beantwortet `read()` mit 0 (Dateiende), was #115/#116 nicht als Fehler behandeln (sie behandeln -1:
`ENODEV` von einem veralteten `/dev/mmd_bidcos`, `EIO` von einem abgezogenen Adapter). rfd auf `main` dreht nach dem
Verlust des Moduls deshalb weiter mit 100 % CPU und meldet `CONNECTED = true`. Der dritte, `aes-republish`: Wird
der Coprozessor hinter einem wiederverbundenen LAN-Gateway neu initialisiert, meldet rfd alle Geräte
(`ADD_LINK_PEER`) und die Schlüssel neu an, nicht aber die AES-Richtlinie je Kanal (`AUTHENTICATION_ON`); bis rfd
neu startet oder die Konfiguration des Kanals erneut geschrieben wird, authentifiziert das Modul die Events der
AES-Kanäle nicht mehr, und rfd verwirft sie (`auth_violate_policy="reject"`) - eine Fernbedienung mit AES verstummt.
Der vierte, `wired-maintenance`: hs485d baut die Kanäle eines neu gefundenen Wired-Geräts ohne ihre Klasse, der
Wartungskanal fehlt also, bis hs485d neu startet und das Gerät aus seiner Datei lädt - `UNREACH`, `STICKY_UNREACH` und
`CONFIG_PENDING` sind bis dahin "unknown internal value", und keine Servicemeldung kommt. Zwei weitere haben die
Durchläufe unter AddressSanitizer gefunden: `metadata-args` - `setVolatileMetadata` (ebenso `getMetadata` und
`setMetadata`) nimmt einen Zeiger in sein erstes Argument und greift dann auf das zweite zu; fehlt es, wird das
Argument-Array neu angelegt und der Zeiger zeigt auf freigegebenen Speicher (heap-use-after-free). Und
`string-uint-conversion` - die Typumwandlung `type_conversion_string_unsigned_integer` in libhsscomm liest den
`c_str()` eines schon zerstörten temporären Strings (stack-use-after-scope), sobald die Kanäle eines HM-OU-LED16
angelegt werden. Und `replace-callback`: Ein Empfänger, der sich nach einem Gerätetausch anmeldet und das alte Gerät noch kennt,
bekommt es als gelöscht statt `replaceDevice` - in rfd liefert `IsDeviceReplaced()` immer `false`, in hs485d steht
im Verlauf die neue Seriennummer statt der alten. Der Test mit dem Empfänger, der sich danebenbenimmt, fand zwei mehr: `init-blocks` - `init` ruft den Empfänger
(`system.listMethods`, `listDevices`) ohne Timeout in der Hauptschleife des Daemons zurück; antwortet er nicht, steht
der ganze Daemon (RPC, Events an andere, Timer, die Funkseite), bis die Verbindung schließt. Und
`async-callback-threads` - jedes unbeantwortete `newDevices`/`deleteDevices`/`replaceDevice` lässt einen Thread und
einen Socket für immer zurück. Gegen `main` bleiben `double-join`, `read-eof`, `aes-republish`, `wired-maintenance`,
`metadata-args`, `string-uint-conversion`, `replace-callback`, `init-blocks`, `async-callback-threads` `dutycycle-upper-bound` (meldet das Modul 100 % Duty Cycle, liest rfd hinter seiner Schwellen-Tabelle; gefunden vom Lasttest) `flush-drops-events` (rfd verwirft vor jedem Befehl ungelesene Eingaben vom Modul; unter Last gehen so Events verloren), `unknown-interface` (`setBidcosInterface` mit einem Interface, das es nicht gibt, meldet Erfolg und speichert es; das Gerät hängt dann am Standard-Interface), `json-substr`, `hexfile-no-data`, `propertymap-long-line` (siehe Fuzzing), `xmlrpc-select-fd` (hat ein Socket von rfd oder hs485d eine Deskriptor-Nummer ab 1024, antwortet der RPC-Server nicht mehr: libXmlRpc wartet noch mit `select()` auf `fd_set`s), `system-command-slot` (zwei Systembefehle an den Coprozessor aus zwei Threads teilen sich einen Platz für die Anfrage; einer bekommt die Antwort des anderen) und `ack-rssi-sign` (das Modul schickt den RSSI der Quittung im Sendestatus als vorzeichenbehaftetes Byte, rfd negiert ihn wie den Betrag im Event: -216 statt -40 dBm auf dem CCU3, +40 auf x86_64, in `RSSI_PEER` und `rssiInfo`). Für jeden Fund liegt ein Issue-Entwurf in [`upstream-reports/`](upstream-reports/); 001-019 sind als
OpenCCU-Base #161-#179 gemeldet, 020 als #185 (die Links stehen in der [Liste](upstream-reports/README.md#die-entwürfe)).

## Wie es funktioniert

- Das Docker-Image holt OpenCCU-Base in einer wählbaren Version (Tag oder Commit, Standard `3.89.11`) und baut daraus
  rfd, hs485d, libXmlRpc und libxmlparser. Von OpenCCU-Base liegt nichts in diesem Repository.
- Das simulierte Funkmodul (`lib/`, Node.js) spricht das serielle Protokoll des Moduls: Framing mit CRC, die
  System- und BidCoS-Befehle, Adresse, Schlüssel, Peers, Uhrzeit, Duty Cycle. Es hängt über ein Pseudo-Terminal
  (`socat`) als Gerätedatei am Daemon. rfd öffnet es wie einen echten `ComPortFile`.
- Hinter dem Modul liegt eine virtuelle Luftstrecke mit simulierten Geräten. Ein Gerät wird von derselben
  `rftypes`-XML-Datei getrieben, aus der rfd seine Telegramme baut (ein kleiner Leser dafür, keine Abhängigkeit); dazu
  kommt das generische BidCoS-Protokoll (Anlern-Ansage, die Konfigurationslisten, Peer-Listen, Statusabfragen,
  Quittungen) und ein dünnes Verhalten je Gerätetyp, der Schaltaktor und die Fernbedienung. Die erste Antwort eines
  Geräts meldet das Modul als Quittung (`TELEGRAM_SENT_RECVD_ACK`), weitere als Events; ein stummes Gerät endet in
  `SEND_FAILED`. AES rechnet die Luftstrecke so, wie es sonst die Modul-Firmware tut: Sie beantwortet die Challenge
  eines Geräts aus der Schlüsseltabelle des Moduls und fordert ein Gerät selbst heraus, wenn rfd dessen Kanal unter
  Authentifizierung gestellt hat (`AUTHENTICATION_ON`); das Modul beantwortet `ADD_LINK_PEER` wie die Firmware mit
  der Zahl der Peers und der Authentifizierungsmaske des Geräts, gegen die rfd seine Richtlinie abgleicht.
  Batteriegeräte schlafen: Ein Wakeup-Gerät hört nur kurz nach seinen eigenen Telegrammen zu, ein Burst-Gerät wacht
  auf ein Burst-Telegramm auf. Hat rfd um das Wecken gebeten, antwortet das Modul auf das nächste Telegramm des Geräts
  mit einem WAKEUP-Telegramm und meldet das Event mit `WOKEN_UP`. Die Fenster sind gewählt, nicht gemessen (300 ms
  nach einem eigenen Telegramm, 1 s nach dem Wecken, 2 s nach einem Burst, 15 s Anlernmodus). Eine Luftstrecke kann
  mehrere Module bedienen (rfd mit zwei Interfaces): Jedes Modul hört ein Gerät mit eigener Feldstärke oder gar nicht,
  ein Telegramm des Geräts und seine Antworten erreichen jedes Modul in Reichweite.
- Das LAN-Gateway gibt es zweimal: hmlangw selbst (unten) für den Klartext und ein Gegenstück in JavaScript
  (`lib/lgw.js`) für `Encryption Key`, den `V`-Handshake und AES-128-CFB auf beiden Ports - mit Schaltern für die
  Reconnect-Szenarien (Port weg, Gateway weg und wieder da, stummes Keepalive, falsche Seriennummer).
- Für hs485d gibt es das Wired-LAN-Gateway in JavaScript (`lib/hmwlgw.js`): dasselbe Vorspiel auf einem Port, dann die
  binären Transport-Frames (`0xFD`, Länge, Nutzlast mit `0xFC`-Escapes) mit den Befehlen `K`, `D`, `S`, `L` und den
  Antworten `a`, `d`/`c`, `r` und `e`, wie hs485d sie erwartet (HMWLGWCommand.h in OpenCCU-Base; Homegears HMW-LGW.cpp
  als Dokumentation gelesen). Dahinter ein Bus (`lib/wired.js`) mit Geräten aus den `hs485types`-Beschreibungen:
  Sysinfo für `h`/`v`, Seriennummer für `n`, ein EEPROM für `R`/`W`/`E`, die Kontrollbyte-Zähler, die hs485d prüft, und
  ein dünnes Verhalten je Typ (der Schaltaktor). Die UDP-Gerätesuche beantwortet `lib/eq3udp.js`.
- hmlangw (MIT, beim Bau des Images aus dem OpenCCU-Repository geholt, Commit
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

- **Gemessen an echter Hardware (2026-10-11):** Das HMW-LGW (Firmware 1.0.5) mit einem HMW-LC-Sw2-DR (Firmware 3.06),
  hs485d 3.89.11 auf Log-Level 0: Die Verbindung mit dem verschlüsselten Vorspiel dauert rund 5 ms, der `K`-Keepalive
  kommt alle 20,0 s und wird in wenigen ms beantwortet, ein `setValue` dauert an hs485ds RPC 57-65 ms, der Aktor meldet
  seinen neuen Zustand von sich aus (INFO_LEVEL) 2,9-3,0 s nach dem Schalten, eine Suche mit einem Gerät endet 1,79 s
  nach dem `D`. Die Vorgaben der Simulation folgen dem: der Bus antwortet in 45 ms, die Statusmeldung kommt 2950 ms nach
  dem Schalten, das Gateway schließt die Suche nach 1750 ms und meldet Firmware 1.0.5. Ein Gerät, das nicht am Bus
  hängt: Das Gateway meldet hs485d nach rund 620 ms einen Fehler (636 ms nach dem RPC, der zweite Versuch 619 ms
  später), obwohl hs485d 200 ms in den Frame schreibt; hs485d versucht es zweimal und setzt dann UNREACH. Die Simulation
  antwortet `a 01` nach 620 ms (`silentDeviceMs`). Das RPI-RF-MOD (über multimacd) mit einem HM-LC-Sw1-Pl-2, rfd auf
  Log-Level 0: Der Coprozessor antwortet in 0,2-0,6 ms, ein Schaltbefehl ist **155 ms** nach dem Schreiben als
  "gesendet, ACK erhalten" gemeldet; rfd fragt den Duty Cycle alle 60 s ab und zusätzlich bei jedem
  `listBidcosInterfaces`. Die Vorgaben folgen (`responseDelayMs` 1, `ackDelayMs` 155). Ein echtes Modul schafft so etwa
  **6,5 Schaltbefehle pro Sekunde**, weit unter den 16,7, die die reine Sendezeit erlaubte. Ein ausgestecktes Gerät:
  "Senden fehlgeschlagen" nach **1106 ms** (1105,5 und 1106,0 ms; `failDelayMs` 1106). Ein Anlernen (ein AES-Gerät): das
  SYSINFO-Telegramm mit Firmware, Typcode, Seriennummer und vier Bytes dahinter, wie es die Simulation baut; rfd
  schreibt Liste 0 (CONFIG_START, CONFIG_WRITE_INDEX, CONFIG_END, je ein ACK nach 149-150 ms), tauscht den Schlüssel
  (zweimal AES_CONTAINER) und liest Parameter und Peers; was das Gerät mit seiner AES-Signatur bestätigt, meldet das
  Modul als "Authentifizierung erfolgreich" nach **405-428 ms** (`authDelayMs` 415), nach dem Schlüsseltausch auch beim
  Ablernen jeden Konfigurationsframe. Der Duty Cycle: 200 bestätigte Schaltbefehle hoben den Wert des Moduls von 14,0
  auf 25,5 % - 0,0575 % (20,7 ms der 36 s) pro Befehl, berechnet sind 20,0 ms; die ACKs der Geräte und rund 150
  Telegramme fremder Geräte in 30 Minuten zählen nicht mit, nach etwa einer Stunde fällt der Wert wieder. Das Modul
  meldet in halben Prozent und schickte zwischen 1,5 und 25,5 % kein Duty-Cycle-Event. Das Modell der Simulation (eigene
  Sendezeit über eine gleitende Stunde, 100 % = 36 s) ist damit bestätigt; die Grenze selbst bleibt ungemessen
  (`refuseAt` 100, gewählt), ebenso das Event bei jedem vollen Prozent.
- **Sendezeit und Duty Cycle (berechnet, nicht gemessen):** Für die Lasttests kann die Luftstrecke den Kanal selbst
  nachbilden (`lib/airtime.js`). Aus dem Rahmenformat der öffentlichen BidCoS-Implementierungen (die CC1101-Einstellung
  von culfw und Homegear, als Dokumentation gelesen): 2-FSK mit 9992,6 Baud, 4 Byte Präambel, zweimal das Sync-Wort,
  das Längenbyte, das Telegramm, 2 Byte CRC - 0,8 ms pro Byte; ein Schaltbefehl mit 14 Byte dauert 20 ms, die Antwort
  ebenso, vor dem Senden 10 ms Pause, ein Burst-Telegramm hat 360 ms Weck-Präambel. Ein Austausch dauert so 60 ms:
  **höchstens etwa 16,7 Schaltbefehle pro Sekunde** über ein Modul. Der Duty Cycle von 1 % erlaubt **36 s eigene
  Sendezeit pro Stunde, etwa 1800 solcher Befehle**. Das Modell reiht die Sendungen, zählt die Sendezeit der Zentrale
  über ein (für Tests verkürzbares) Fenster, meldet sie als Duty Cycle des Moduls und lehnt bei 100 % mit
  `SEND_FAILED_DUTYCYCLE` ab (gewählt). rfd sendet synchron, einen Austausch nach dem anderen, in Reihenfolge, ohne
  etwas zusammenzufassen oder zu verwerfen; `setValue` antwortet nach dem ACK. Nach zwei fehlgeschlagenen Sendungen an
  ein Gerät (auch durch Duty-Cycle-Ablehnung) versucht rfd es bis `FAIL_COUNTER_RESET_TIME` nicht mehr und antwortet
  sofort mit dem Fault "Failure".

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

Jeder Daemon-Test hat ein eigenes Timeout, und `test/helpers/hang-guard.js` lässt eine Testdatei scheitern, deren Prozess
nach dem letzten Test nicht endet (ein offenes Handle, ein Daemon, den ein abgelaufener Test zurückließ - so lief
`hs485d-lgw.test.js` einmal 20 Stunden): zurückgebliebene Daemons werden beendet und genannt, und nach
`HMRS_HANG_GRACE_MS` (30 s) gibt der Wächter die offenen Handles aus und beendet den Prozess mit 1, statt dass
`node --test` ewig wartet.

Das Image basiert absichtlich auf Debian trixie: Die Sanitizer-Laufzeiten von bookworm (LLVM 14, GCC 12) stürzen auf
Kerneln mit 32 Bit `mmap`-Randomisierung beim Start ab, was wie ein sporadischer Segfault in jedem vierten ASan-Lauf
aussieht; LLVM 19 und GCC 14 aus trixie haben das Problem nicht.

Die Ergebnisse landen in `results/<variante>/` (JUnit, Logs der Daemons, Sanitizer-Berichte), Fuzzing-Funde in
`results/fuzz/artifacts/`. Die CI (`.github/workflows/ci.yml`) testet vier OpenCCU-Base-Stände nebeneinander: die beiden neuesten Release-Tags (heute `3.89.9` und `3.89.11`), den aktuellen Stand von `main` und den Zweig `lite-3.89.11` des Forks [hobbyquaker/OpenCCU-Base](https://github.com/hobbyquaker/OpenCCU-Base). Aus diesem Zweig baut [openccu-lite](https://github.com/hobbyquaker/openccu-lite) seine Daemons: das Tag `3.89.11` mit Upstream-Fixes, die per `git cherry-pick -x` übernommen sind, und mit eigenen Fixes, die upstream noch fehlen (Kandidaten für Pull Requests, etwa zu #164, #165, #170 und #171). So zeigt der Bericht, was dieser Build behebt und upstream noch nicht. Die Stände werden bei jedem Lauf neu bestimmt, der Zweig wie `main` auf seinen neuesten Commit
(`scripts/resolve-refs.mjs`: Tags der Form `X.Y.Z`, nach Version sortiert); kommt ein neues Tag dazu, fällt das älteste
heraus. Jede Version läuft in den Varianten normal, ASan und coverage, und jeder Fuzzer läuft 60 s gegen jede.

## Testbericht

Jeder CI-Lauf schreibt eine Markdown-Übersicht in seine Zusammenfassung auf GitHub (je Job, und für den ganzen Lauf im
Job "test report"). Der Lauf auf `main` veröffentlicht dazu einen HTML-Bericht auf GitHub Pages:
**<https://hobbyquaker.github.io/hm-radio-simulator/>** - die vier OpenCCU-Base-Stände nebeneinander (älteres Tag, neueres Tag, `lite-3.89.11`, `main`, je mit verlinktem Commit; die Commits des Zweigs im Fork), dazu die Fuzzing-Läufe und ein Verlauf der letzten 20 Läufe
(`runs/<id>/`). Je Version gibt es **eine** Ergebnisspalte: Stimmen die Varianten (normal, ASan, coverage) überein,
steht dort ihr gemeinsames Ergebnis; weichen sie ab, das schlechteste mit einem kleinen Chip für die Variante (`A`
ASan, `C` coverage, `R` normal), Tooltip und Aufklappbereich zeigen jede Variante. Die coverage-Variante zählt nur, wo
sie von der normalen abweicht. Jede Testzeile ist beim Laden eine Zeile; aufgeklappt zeigt sie zuerst in ein, zwei
Sätzen, was der Test prüft (`test/descriptions.js` - ein Test ohne Beschreibung lässt den CI-Job "every test has a
description" scheitern), dann die Diagnosen. Ein Link führt zu den Zeilen, in denen die Varianten abweichen. Über den Tests liegt
eine **Filterleiste** (Ergebnis, abweichende Varianten, Daemon, Art, Beweis, Ergebnis auf einem Stand, Textsuche über
Name, Datei und Beschreibung, jeweils mit Anzahl); der Filter steht im Link (`#f=fail,rfd&q=lgw`), so lässt sich eine
Ansicht teilen. Ohne JavaScript bleibt die Leiste verborgen und alle Zeilen sichtbar. Ganz oben steht
ein **Trend** je Version: bestanden, todo, fehlgeschlagen und übersprungen für rfd und hs485d und die Zeilenabdeckung
(je Daemon und insgesamt), jeweils mit der Änderung gegenüber dem vorigen Lauf (▲/▼, = unverändert; grün besser, rot
schlechter) und einer kleinen Verlaufslinie über die aufbewahrten Läufe. Eine Version, die erst neu im Fenster ist,
zeigt, seit wann sie dabei ist. So liest
man ihn:

- **regression** - der Test pinnt einen behobenen Fehler in OpenCCU-Base fest und verlinkt den Pull Request und den
  Merge-Commit (oder, bei einem älteren Fix ohne Pull Request, den Commit); auf einer Version vor dem Fix läuft er als **todo** (bekannt kaputt, der Lauf bleibt grün);
- **proven** / **not proven** - ob ein Regressionstest ohne seinen Fix nachweislich scheitert: `scripts/prove.mjs` baut
  die Daemons am Commit vor dem Fix und am Merge-Commit und lässt dort nur die Tests mit der Nummer des Fixes laufen,
  normal und mit ASan (Races und Lebensdauerfehler am Commit davor bis zu fünfmal unter ASan). **proven**: Der Test
  scheitert vor dem Fix und besteht mit ihm; **not proven**: Er besteht auch vor dem Fix, erreicht also nicht, was der
  Fix ändert; **inconclusive**: Er scheitert auf beiden. Ein Fix, den es nur im Fork gibt, wird am Fork-Commit und am Commit davor geprüft, unter der Nummer seines Issues. Das Ergebnis steht je Test im Feld `proof` von `report.json`,
  der ganze Nachweis in `proof.json`. Er kostet zwei Image-Builds je Fix; die CI führt ihn deshalb wöchentlich, auf
  Anforderung (`workflow_dispatch` mit `prove`) und bei einem Push aus, der die Fix-Liste oder einen Regressionstest
  ändert; dazwischen behält der Bericht den letzten. Lokal: `node scripts/prove.mjs local [--fixes 9,16]`;
- **known bug** - ein Fund dieser Suite ohne Fix upstream (`double-join`, `read-eof`, `aes-republish`, `wired-maintenance`, `metadata-args`, `string-uint-conversion`, `replace-callback`, `init-blocks`, `async-callback-threads`, `dutycycle-upper-bound`, `flush-drops-events`, `unknown-interface`, `json-substr`, `hexfile-no-data`, `propertymap-long-line`, `xmlrpc-select-fd`, `system-command-slot`, `ack-rssi-sign`); verlinkt das Issue oder,
  solange es keins gibt, den Abschnitt oben;
- **behaviour** - ein gemessenes Verhalten der Daemons; **fuzz** - die geseedeten Fuzzing-Tests der Suite.

Dazu kommt die **Code-Abdeckung** von rfd und hs485d: Eine dritte Build-Variante `coverage` (clang, Source-based
Coverage, `-O0`) läuft dieselbe Suite; der Bericht zeigt je OpenCCU-Base-Version Zeilen, Funktionen und Zweige für die
Daemons selbst und jede Bibliothek als eigene Zeile sowie je Datei die Prozente, und verlinkt die Daten zum Herunterladen
(lcov-Tracefile und llvm-cov-JSON, nur Dateipfade und Zähler, kein Quelltext: mit einem OpenCCU-Base-Checkout auf dem
Commit rendert `genhtml --prefix /openccu-base coverage.info` die annotierte Ansicht). Vor dem Fix zu OpenCCU-Base #164 hatten
die Daemons keinen SIGTERM-Handler und würden ihr Profil beim Stoppen verlieren; die Variante nutzt deshalb clangs
Continuous Mode, in dem die Zähler in einer eingeblendeten Datei liegen.

**Das Differential:** Die Release-Jobs halten die Antworten der Durchläufe fest (`results/<variante>/sweep/*.json`,
kurze Zusammenfassungen: die Schlüssel eines Structs, die Länge eines Arrays und sein erstes Element, Code und Text
eines Faults). Der Bericht vergleicht benachbarte Versionen (älteres Tag mit neuerem, neueres mit `main`) und `main` mit dem Commit, den der zuvor veröffentlichte
Bericht geprüft hat (dessen Antworten liegen als `sweep/main.json` auf der Seite), und listet, was sich geändert hat.
Eine Änderung ist kein Fehler; `getVersion` wird bewusst ignoriert.

Die Daten dahinter liegen als `report.json` neben der Seite. Nichts davon ist im Repository eingecheckt; der Bericht
entsteht aus den Artefakten des Laufs (`scripts/report.mjs`), lokal mit `npm run report` nach `scripts/run-tests.sh`.

## Wenn sich OpenCCU-Base bewegt

Ein Push in ein fremdes Repository kann unseren Workflow nicht auslösen. Deshalb fragt der Workflow
`upstream-watch.yml` alle 15 Minuten den Stand von OpenCCU-Base `main` und des Fork-Zweigs `lite-3.89.11` ab, merkt sich die zuletzt geprüften Commits auf dem Branch `upstream-state` (nur dieser Workflow schreibt ihn) und lässt bei einem neuen Commit die Suite genau dafür laufen - über den CI-Workflow als wiederverwendbaren Workflow, mit den beiden neuesten Tags daneben wie sonst auch. Der Lauf erscheint im Bericht und im Verlauf mit "triggered by OpenCCU-Base `<sha>`" (oder "lite-3.89.11 `<sha>`", wenn sich nur der Zweig bewegt hat) und verlinktem Commit. Mehrere Commits innerhalb
eines Intervalls prüft er als ihren neuesten Stand; der Commit auf dem Zustandsbranch zählt zugleich als Aktivität, so
dass GitHub den Zeitplan nicht abschaltet. Ein roter Lauf hinterlässt eine Warnung im Lauf; ein Issue dazu öffnet er
nicht, solange der Maintainer das nicht möchte. `workflow_dispatch` mit `force` prüft den aktuellen Stand erneut.

## Roadmap

- ✅ **Stufe 0:** Docker-Image mit den Daemons aus OpenCCU-Base, RPC-Tests der Daemons, Regressionstests
- ✅ **Stufe 0:** libFuzzer für libXmlRpc und libxmlparser
- ✅ **Stufe 1a:** simuliertes RPI-RF-MOD an einem Pseudo-Terminal: Initialisierung, Modul weg und wieder da,
  Frame-Fuzzing
- ✅ **Stufe 1b:** LAN-Gateway über
  [hmlangw](https://github.com/OpenCCU/OpenCCU/tree/master/buildroot-external/package/hmlangw) vor dem simulierten
  Modul, ohne Verschlüsselung
- ✅ **Stufe 2:** ein simulierter Schaltaktor aus den `rftypes`-Beschreibungen: Anlernen, Schalten mit ACK, Status,
  UNREACH, CONFIG_PENDING, Duty Cycle; Vergleich alte gegen neue OpenCCU-Base-Version
- ✅ **Stufe 3:** eine Fernbedienung, das LAN-Gateway mit AES-Handshake und Reconnects, AES-gesicherte Geräte,
  Direktverknüpfungen, das Modul stromlos hinter dem Gateway
- ✅ **Stufe 4:** hs485d gegen ein simuliertes Wired-LAN-Gateway mit einem Wired-Aktor: Suche, Schalten, Tasten,
  EEPROM-Paramsets, Verknüpfung, Keepalive-Ausfall, Neustart; dazu die UDP-Gerätesuche für beide Daemons
- 🤷 **Stufe 5:** multimacd in einer VM mit `eq3_char_loop` und dem Protokoll des Dual-Coprozessor-Moduls
- ✅ **Testbericht:** Markdown-Übersicht in jedem CI-Lauf und ein HTML-Bericht auf GitHub Pages mit Verlauf, Links zu
  den Upstream-Fixes und -Issues, den OpenCCU-Base-Commits je Version und den Fuzzing-Ergebnissen
- ✅ **Testbericht:** die vier Ergebnisspalten in jeder Tabelle rechtsbündig und gleich breit
- ✅ **Testbericht:** Code-Abdeckung von rfd und hs485d durch die Suite, im Bericht
- ✅ **Upstream-Berichte:** der Ordner [`upstream-reports/`](upstream-reports/) mit einem Issue-Entwurf je Fund in den
  Daemons; 001-019 gemeldet als OpenCCU-Base #161-#179, 020 als #185
- ✅ **Suite bei jedem neuen OpenCCU-Base-Commit:** alle 15 Minuten den Stand von `main` abfragen und bei einem neuen
  Commit die Suite genau dafür laufen lassen, mit Hinweis im Bericht
- ✅ Kalibrierung des Modul-Timings an einem echten RPI-RF-MOD
- ✅ Kalibrierung des HMW-LGW-Timings an einem echten Wired-LAN-Gateway (hs485d)
- ✅ **RPC-Methoden-Durchlauf,** Gerätetyp-Durchlauf über alle `rftypes`-Beschreibungen, der Vergleich 3.89.11 gegen main
- ✅ **Der Empfänger-Vertrag:** mehrere Empfänger, `init`-Synchronisation, Event-Reihenfolge, die Unerreichbar-Regel,
  ein hängender Empfänger
- ✅ **Neustart, Gerätedateien und Konfiguration:** Persistenz, kaputte Dateien, Adressvergabe, die Start-Matrix
- ✅ **`listMethods` stimmt:** jede gelistete Methode ist aufrufbar, und keine aufrufbare fehlt in der Liste
- ✅ **Ein Event-Empfänger, der sich danebenbenimmt, blockiert nichts:** Server weg mitten im Callback, keine oder
  falsche Antworten
- ✅ **Last:** schnelle `setValue`-/`putParamset`-Salven, Funk-Events währenddessen, die Warteschlange von rfd, Grenzen
  aus Sendezeit und Duty Cycle
- ✅ **Labormessungen, die Handgriffe brauchen** (gemessen und in die Vorgaben übernommen): ein stummes Wired-Gerät, ein Senden an ein abwesendes BidCoS-Gerät,
  ein Anlernen, ein Duty-Cycle-Event
- ✅ **Drei OpenCCU-Base-Stände nebeneinander:** die zwei neuesten Tags und der Stand von `main`, automatisch gewählt
- ✅ **Regressionstests beweisen:** jeder Test einmal gegen den Commit vor dem Fix (dort rot) und gegen den Fix (grün), im
  Bericht als „bewiesen“ markiert
- ✅ **Lesefehler am seriellen Gerät (#115/#116):** ein `read()`, das wirklich mit ENODEV/EIO scheitert, damit die Tests
  den reparierten Code erreichen
- ✅ **LAN-Gateway, was noch fehlt (#13/#17):** gescheiterte Wiederherstellung nach dem Reconnect, keine Telegramme
  währenddessen, der Keepalive-Thread, Hello ohne Seriennummer, die Statusdatei, auf TCP-Segmente verteilte Frames,
  Sockets über 1024
- ✅ **AES-CBC-MAC-Telegramme (#4)** auf einem Kanal mit `aes_cbc` (eine Kopie der `rftypes`, OpenCCU-Base liefert keinen) und das korrigierte `LONG_ACT_TYPE`-Register des HM-OU-CFM-TW (#63)
- ✅ **Ältere Fixes festhalten:** Adress- und Seriennummernformate von hs485d, Dateien ohne Punkt, ungewöhnliche Antworten
  an libXmlRpc, der 49-Tage-Überlauf der Uhr (libfaketime)
- ✅ **Testbericht kompakter:** eine Ergebnisspalte je OpenCCU-Base-Stand; normal, ASan und Coverage nur dort einzeln,
  wo sie sich unterscheiden; jede Zeile einzeilig, Details und eine kurze Erklärung des Tests zum Aufklappen
- ✅ **Trend im Testbericht:** oben ein Panel mit Verlaufslinien je Stand und Daemon für bestanden, todo, fehlgeschlagen
  und die Abdeckung, mit Pfeilen für die Veränderung
- ✅ **Testergebnisse filtern:** nach Ergebnis, Daemon, Art, Stand und Text, als Link teilbar
- ☑️ **Firmware-Update-Abläufe** mit simuliertem Gerät (rfd) und der Hexfile-Pfad (hs485d)
- ✅ **Weitere Fuzz-Ziele:** Frames eines angelernten Geräts, Frame-, LGW-, XML- und Gerätedatei-Parser
- ☑️ **Eine ThreadSanitizer-Variante** des Images
- ✅ **RSSI im ACK:** das Modul schickt den RSSI-Wert im Sendestatus vorzeichenbehaftet, rfd liest ihn ohne Vorzeichen (`RSSI=-236dB`); Simulator angleichen, Test, Entwurf für OpenCCU-Base
- ✅ **Fehler: ein hängender Test bricht nicht ab:** `hs485d-lgw.test.js` lief 20 Stunden; jeder Daemon-Test bekommt ein Timeout
- ✅ **Eine vierte Spalte für openccu-lite:** der OpenCCU-Base-Zweig `lite-3.89.11` des Forks [hobbyquaker/OpenCCU-Base](https://github.com/hobbyquaker/OpenCCU-Base) (3.89.11 mit übernommenen Fixes) neben 3.89.9, 3.89.11 und `main`; übernommene Fixes werden an `cherry picked from` erkannt
- 🏗️ **Die Stände neu geordnet:** je das neueste Tag und der aktuelle Stand von OpenCCU-Base (`main`) und vom Fork [hobbyquaker/OpenCCU-Base](https://github.com/hobbyquaker/OpenCCU-Base) (das neueste openccu-lite-Tag `v*` und der Zweig `lite`, bisher `lite-3.89.11`); die Überwachung beobachtet beide Repositories und lässt bei jeder Bewegung die Suite laufen
- 🏗️ **Fehler: überlappende CI-Läufe:** der zuletzt veröffentlichte Bericht verliert den Verlaufseintrag des anderen Laufs; Bericht und Veröffentlichung nacheinander statt parallel
- ✅ **Ein Wakeup-/Burst-Gerät:** WOKEN_UP, die Wakeup-Warteschlange, Burst, verzögertes Löschen
- ✅ **Zwei Interfaces:** Roaming, RSSI, `setBidcosInterface`, die Duty-Cycle-Stufen

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
