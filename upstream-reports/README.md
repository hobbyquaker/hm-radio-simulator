# Upstream-Berichte

Funde in den Daemons von [OpenCCU-Base](https://github.com/OpenCCU/OpenCCU-Base), die diese Suite gemacht hat, als
Entwürfe für Issues dort - **noch nicht gemeldet**. Ob und wann ein Entwurf als Issue aufgemacht wird, entscheidet der
Maintainer; bis dahin verlinken der [Testbericht](https://hobbyquaker.github.io/hm-radio-simulator/) und das README
die Entwürfe hier, wo sie früher auf den Abschnitt mit den Funden im README zeigten.

Eine Datei je Fund, `NNN-<kurzname>.md`, auf Englisch (so, wie ein Issue in OpenCCU-Base geschrieben würde), mit
einem Vorspann:

```yaml
---
status: draft # oder: reported: <URL des Issues>   oder: fixed upstream: <Commit>
component: rfd # rfd, hs485d, libelvutils, ...
refs: [3.89.11, main] # die geprüften OpenCCU-Base-Stände
suite: double-join # der Name, unter dem die Suite den Fund als todo führt (wenn es einen Test gibt)
---
```

Jeder Entwurf hält sich an das, was sich beobachten lässt: was passiert, wie man es mit der Suite oder einem kleinen
Client nachstellt, was zu erwarten wäre, die Ursache soweit sie im **öffentlichen** Quelltext von OpenCCU-Base
sichtbar ist (Datei:Zeile, verlinkt auf den Commit), und ein Vorschlag für den Fix. Keine Details aus einem Labor,
nichts aus nicht-öffentlichen Quellen.

## Die Entwürfe

| Datei                                                                | Komponente       | Kurz                                                                                                                                | Suite               |
| -------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| [001-double-join.md](001-double-join.md)                             | libelvutils, rfd | `Actor::Stop()` joint den Dispatcher-Thread ein zweites Mal; unter ASan bricht rfd bei `init(url, "")` ab                           | `double-join`       |
| [002-read-eof.md](002-read-eof.md)                                   | rfd              | Dateiende auf dem seriellen Gerät: rfd dreht mit 100 % CPU und bleibt `CONNECTED`                                                   | `read-eof`          |
| [003-exit-rpc-method.md](003-exit-rpc-method.md)                     | rfd              | die RPC-Methode `exit` ist immer einkompiliert: jeder Client kann rfd beenden                                                       | -                   |
| [004-no-sigterm-handling.md](004-no-sigterm-handling.md)             | rfd, hs485d      | kein SIGTERM-Handler: ein anstehendes Speichern geht beim Stoppen verloren                                                          | -                   |
| [005-aes-policy-after-reinit.md](005-aes-policy-after-reinit.md)     | rfd              | nach einer Neuinitialisierung des Coprozessors fehlt die AES-Richtlinie je Kanal: Events von AES-Fernbedienungen werden verworfen   | `aes-republish`     |
| [006-wired-maintenance-channel.md](006-wired-maintenance-channel.md) | hs485d           | ein neu gefundenes Wired-Gerät bekommt einfache Kanäle: UNREACH, STICKY_UNREACH und CONFIG_PENDING gibt es erst nach einem Neustart | `wired-maintenance` |

Neue Funde späterer Stufen kommen auf dieselbe Weise dazu.

## Nachstellen

Die Tests, die ein Fund als `todo` führt, laufen im Docker-Image der Suite (siehe das [README](../README.md)):

```sh
scripts/run-tests.sh --ref main --variants asan
docker run --rm --init --cap-add SYS_NICE -e HMRS_VARIANT=asan hm-radio-simulator:main \
  node --test test/daemon/rfd-rpc.test.js
```

Ohne den Fund in `HMRS_KNOWN_BROKEN` (die Umgebungsvariable, die das Image je Version setzt) läuft der Test rot statt
als `todo`.
