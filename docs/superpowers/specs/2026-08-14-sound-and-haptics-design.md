# Space Taxi — Triebwerksklang, Sprachausgabe, Vibration

**Datum:** 2026-08-14
**Datei:** `index.html`, Diagnoseseite `test-speech-vibration.html`
**Verwandt:** [Mobile-Support](2026-08-14-mobile-support-design.md) ·
[Zufallsrouten, Passagier-Kollision, Fahrwerk](2026-08-14-gameplay-fares-and-gear-design.md)

## Ziel

Den Ton vom Piepser-Niveau lösen und Haptik über den Crash hinaus nutzen:

1. Schubgeräusch, das nach Triebwerk klingt statt nach Klickfolge
2. Sprachausgabe für den „HEY TAXI!"-Ruf
3. Vibration bei Landung, Sprit-Warnung, Ruf und Dauerschub

## Ausgangslage

Der Ton bestand aus `beep(freq, dur, type, vol)`, einem Oszillator mit
Hüllkurve. Das Schubgeräusch war ein 90-Hz-Sawtooth, alle vier Frames neu
angestoßen — hörbar als Klickfolge, nicht als Triebwerk. `sndHeyTaxi` waren zwei
Töne. Vibration existierte als `vibrate()`-Helfer, aufgerufen ausschließlich in
`crash()`.

## Entscheidungen

| Thema | Entscheidung |
|---|---|
| Schub | Durchgehender Rauschmotor, Gains werden ein- und ausgeblendet |
| Sprache | Web Speech API mit Retro-Anmutung statt Formantsynthese |
| Vibration | Landung, Sprit-Warnung, „HEY TAXI", Dauerrumpeln beim Schub |

Nicht gewählt: Zusatzvibration beim Ein- und Aussteigen.

### Eine Korrektur an der Entscheidungsgrundlage

Die Option „TTS mit Retro-Verzerrung" war so, wie sie angeboten wurde, **nicht
baubar**. `speechSynthesis` gibt direkt auf den Systemausgang aus; in keinem
Browser lässt sich diese Ausgabe in einen `AudioContext` leiten und dort durch
einen Bitcrusher schicken. Einstellbar sind ausschließlich `pitch`, `rate`,
`volume` und die Stimmenauswahl.

Umgesetzt wurde deshalb die nächstliegende erreichbare Variante: tief gesetzter
Pitch plus eine **separate** Störschicht aus WebAudio, die unter der Stimme
läuft. Die Verzerrung liegt neben der Stimme, nicht auf ihr.

## Komponenten im Detail

### 1. Raketentriebwerk

Eine dauerhaft laufende Rauschschleife (2 s Puffer, einmalig erzeugt) wird auf
zwei parallele Filter gelegt:

| Zweig | Filter | Gain Hauptschub | Gain Seitenschub | Gain aus |
|---|---|---|---|---|
| Grollen | Tiefpass, Q 3 | 0,20 | 0,06 | 0 |
| Zischen | Hochpass 2400 Hz | 0,05 | 0,04 | 0 |

Die Tiefpass-Grenzfrequenz wandert zwischen 200 Hz (Hauptschub) und 340 Hz
(Seitenschub) — dadurch sind die Triebwerke am Klang unterscheidbar, ohne dass
eine zweite Klangquelle nötig wäre. Alle Übergänge laufen über
`setTargetAtTime` mit 0,04 s bzw. 0,06 s Zeitkonstante.

**`setThrustSound` ist idempotent:** Es merkt sich den zuletzt gesetzten
Zustand und automatisiert nur bei echter Änderung. Ohne das würden bei 60 Hz
dreimal pro Frame Rampen auf denselben Zielwert gesetzt.

**Angesteuert wird einmal pro gezeichnetem Frame aus `gameLoop`, nicht pro
Simulationsschritt.** Damit stimmt der Klang auch in Zuständen, in denen
`update()` gar nicht läuft: pausiert, abgestürzt, Titelbildschirm. Der alte
`thrustTimer` entfiel dabei ersatzlos.

### 2. „HEY TAXI!"

`sndHeyTaxi()` besteht aus drei Teilen:

- **Störschicht** (`heyTaxiCrackle`): Bandpass-Rauschen bei 1400 Hz, dessen Gain
  in zehn Stufen à 45 ms zwischen 0,008 und 0,035 springt — klingt nach
  zerhackter Sample-Wiedergabe.
- **Stimme** (`speakHeyTaxi`): `pitch 0.3`, `rate 0.85`, `volume 0.9`, bevorzugt
  eine englische Systemstimme.
- **Vibration**: `[25, 50, 25]`.

**Dreifacher Rückfall auf Beeps**, weil TTS real stumm bleiben kann: kein
`speechSynthesis` vorhanden, `onerror`, oder kein `onstart` innerhalb von
400 ms. Ohne diesen Wachhund verschwände der Ruf auf iOS oder bei noch nicht
geladenen Stimmen ersatzlos.

### 3. Vibration

| Ereignis | Muster | Bemerkung |
|---|---|---|
| Landung weich | `[18]` | unter 1,0 px/Schritt Aufprall |
| Landung hart | `[55]` | ab 1,0; Crash-Schwelle liegt bei 1,8 |
| Sprit-Warnung | `[30, 70, 30]` | im Takt des bestehenden Warntons |
| „HEY TAXI" | `[25, 50, 25]` | |
| Crash | `[60, 40, 120]` | bereits vorher vorhanden |
| Tanken mit Fahrgast | `[180]` | siehe Gameplay-Spec |
| Dauerschub | 220 ms alle 200 ms | siehe unten |

**Dauerrumpeln:** `navigator.vibrate` kennt keinen anhaltenden Modus. Ein
220-ms-Impuls wird alle `RUMBLE_STEPS = 12` Simulationsschritte (= 200 ms)
nachgereicht und überlappt dadurch zu einem gleichmäßigen Rumpeln. Das kostet
Akku und ist hörbar gestuft — bewusst akzeptiert, Stellschraube ist
`RUMBLE_STEPS`.

## Fehlerbehandlung

| Fall | Verhalten |
|---|---|
| AudioContext noch nicht entsperrt | `setThrustSound` kehrt zurück, bis eine Geste vorliegt |
| `speechSynthesis` fehlt oder schweigt | Beep-Fallback über drei unabhängige Wege |
| Vibration nicht unterstützt | `vibrate()` prüft und kehrt zurück |
| Pause / Hintergrund | Triebwerk auf 0, Rumpeln abgebrochen, Kontext suspendiert |
| Crash während des Rumpelns | siehe unten |

### Die Crash-Falle

Nach einem Crash ist `flying` falsch, also hätte `setThrustHaptics(false)` im
selben Frame `navigator.vibrate(0)` geschickt und **das gerade abgesetzte
Crash-Muster überschrieben**. `crash()` löscht die Rumble-Flags deshalb, ohne zu
canceln. Diese Reihenfolge ist nicht offensichtlich und hat einen eigenen Test.

Als `refuelViolation()` hinzukam, wanderte genau diese Logik in das gemeinsame
`loseLife(reason)` — sonst hätte der zweite Pfad die Feinheit duplizieren müssen.

## Der iOS-Befund

Getestet wurde in Safari auf einem echten iOS-Gerät. Ergebnis:

**Vibration ist auf iOS nicht lösbar.** WebKit hat die Vibration API nie
implementiert, `navigator.vibrate` existiert dort nicht, die Taptic Engine ist
für Webinhalte nicht zugänglich. Kein Flag, kein Workaround. Der Code verhält
sich korrekt — er findet die Funktion nur nie. Dass keine Berechtigung abgefragt
wird, ist ebenfalls erwartbar: **weder Vibration noch Sprachausgabe kennen ein
Permission-Prompt.**

Einziger Rest: Safari 17.4+ erzeugt Haptik als Nebeneffekt beim Umlegen eines
`<input type="checkbox" switch>`. Das ist kein API-Zugang — es lässt sich nicht
programmatisch auslösen und taugt daher nicht für Crash, Landung oder Schub.

**Sprachausgabe ist vermutlich reparierbar, aber noch unbestätigt.** iOS
verlangt, dass die erste Utterance synchron aus einem Benutzer-Gesture stammt.
`sndHeyTaxi()` feuert aus einem Timer in der Spielschleife — nie aus einem Tap.
Dazu kommt `speechSynthesis.cancel()` unmittelbar vor `speak()`, was Safari
bekanntermaßen Utterances verschlucken lässt.

### Diagnoseseite

`test-speech-vibration.html` trennt die drei Fälle, die von außen gleich
aussehen: API fehlt, API meldet Erfolg ohne Wirkung, API schlägt echt fehl. Sie
protokolliert Umgebung, Stimmenliste und jedes Utterance-Event.

Der entscheidende Vergleich sind die Buttons **E** (speak aus einem Timer, ohne
Gesture — wie im Spiel) und **F** (stumme Priming-Utterance im Tap, echte
Ausgabe danach aus dem Timer). Ein WebAudio-Beep-Button trennt zusätzlich
„TTS kaputt" von „Seite ist stumm".

**Offen:** Das Testergebnis liegt noch nicht vor. Erst danach lässt sich
entscheiden, ob Priming in `unlockAudio()` der richtige Fix ist, ob das
`cancel()` entfallen muss, oder ob etwas anderes vorliegt. Bis dahin wird nichts
geändert — die vier möglichen Ausgänge führen zu verschiedenen Korrekturen.

## Verifikation

Der Verhaltens-Harness stubt WebAudio, `speechSynthesis` und `navigator.vibrate`
und protokolliert, welche Knoten mit welchen Werten angesteuert werden. Geprüft
werden unter anderem: Aufbau des Motorgraphen, Idempotenz von `setThrustSound`,
hellerer Cutoff der Seitendüsen, Schließen beider Gains beim Loslassen, TTS mit
abgesenktem Pitch, Beep-Fallback bei entferntem `speechSynthesis`, härtere
Vibration bei härterer Landung, Rumpel-Intervall über 36 Schritte, sauberes
Abbrechen, und dass der Crash-Buzz nicht überschrieben wird.

Zwei Funde betrafen das Testwerkzeug, nicht das Spiel:

- **Node 21+ hat ein eigenes schreibgeschütztes `navigator`.** Eine Zuweisung
  `globalThis.navigator = {…}` wird still verworfen; nötig ist
  `Object.defineProperty`. Vorher schlug jede Vibrationsprüfung fehl.
- **`setTimeout` war als No-Op gestubt.** `sndSad` plant *alle* Noten über
  Timer, also war kein einziger Ton messbar. Ersetzt durch eine echte
  Warteschlange mit `flushTimers()`, wodurch nun auch `sndCrash` und
  `sndPickup` prüfbar sind.

**Nicht automatisiert prüfbar ist der Klang.** Die Tests belegen, dass die
richtigen Knoten mit den richtigen Werten angesteuert werden — nicht, dass das
Triebwerk nach Rakete klingt oder das Rumpeln angenehm ist.

## Bewusst nicht enthalten (YAGNI)

- Keine Formantsynthese als Ersatz für TTS (bleibt Option, falls die
  Systemstimme zu glatt klingt — `heyTaxiBeeps()` ist der Umschaltpunkt)
- Keine Lautstärkeregelung und kein Stummschalter
- Keine Musik
- Keine Vibration beim Ein- und Aussteigen
- Kein Umweg über `<audio>`/`<video>`, um die iOS-Audiosession zu beeinflussen
