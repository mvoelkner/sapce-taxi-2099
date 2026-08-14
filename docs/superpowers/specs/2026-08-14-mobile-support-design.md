# Space Taxi — Mobile-Support

**Datum:** 2026-08-14
**Datei:** `index.html` (Single-File, kein Build-Schritt)
**Nachfolger:** [Zufallsrouten, Passagier-Kollision, Fahrwerk](2026-08-14-gameplay-fares-and-gear-design.md) ·
[Triebwerksklang, Sprachausgabe, Vibration](2026-08-14-sound-and-haptics-design.md)

> **Hinweis:** Zeilenangaben in diesem Dokument beziehen sich auf den Stand vor
> der Umsetzung. Durch die hier und im Nachfolge-Spec beschriebenen Änderungen
> haben sie sich verschoben — maßgeblich sind die genannten Funktions- und
> Bezeichnernamen.
>
> Die Aussage „alle Level-Koordinaten bleiben unverändert" gilt für *diese*
> Änderung. Das Nachfolge-Spec verbreitert die Pads anschließend bewusst.

## Ziel

Das bestehende Canvas-Spiel zusätzlich auf Smartphones und Tablets spielbar machen.
Die Desktop-Bedienung per Tastatur bleibt unverändert erhalten.

## Ausgangslage

`index.html` (972 Zeilen) enthält ein vollständiges Space-Taxi-Remake in einem
IIFE. Fünf Level, Partikelsystem, Beep-Synth, fünf Spielzustände.

Sechs Dinge blockieren die mobile Nutzung:

1. **Feste Canvas-Größe** — `<canvas width="800" height="500">` (Z. 60); `W`/`H`
   werden aus `canvas.width`/`canvas.height` gelesen (Z. 75–76). Auf einem
   390 px breiten Gerät ragt das Spielfeld heraus und `body { overflow: hidden }`
   schneidet es ab.
2. **Nur Tastatur-Input** — `keydown`/`keyup` auf `ArrowUp/Left/Right` (Z. 130–131,
   ausgewertet in Z. 352–354) und `Space` (Z. 936). Kein Touch-Handling.
3. **Audio bleibt stumm** — `ensureAudio()` läuft nur im Space-Handler. iOS und
   Android entsperren den AudioContext ausschließlich in einem echten
   User-Gesture.
4. **Frameraten-Abhängigkeit** — Die Physik rechnet pro Frame ohne Delta-Zeit
   (Z. 364–376). Auf 120-Hz-Displays läuft das Spiel doppelt so schnell.
5. **Mehrfingerbedienung nötig** — Auftrieb und Seitenschub gleichzeitig ist
   Kern des Spiels; Touch muss mehrere Berührungen parallel tracken.
6. **Browser-Gesten** — Doppeltipp-Zoom, Pull-to-Refresh, Textauswahl und
   Überscrollen stören das Spielen.

## Entscheidungen

| Thema | Entscheidung |
|---|---|
| Ausrichtung | Querformat erzwingen, Overlay-Hinweis im Hochformat |
| Steuerung | Sichtbare On-Screen-Buttons, Multi-Touch |
| Skalierung | Native Auflösung über `devicePixelRatio` |
| Button-Lage | Halbtransparentes Overlay über den unteren Ecken |
| Zusatz | Delta-Time, Audio-Unlock, Gesten-Sperre, Fullscreen, Vibration |

## Architektur

Die Spiellogik, alle Level-Koordinaten und alle Physik-Konstanten bleiben
unverändert. Das Spiel rechnet weiterhin in einem festen
800×500-Weltkoordinatensystem. Alles Mobile-Spezifische kommt in drei neue,
klar abgegrenzte Blöcke:

| Block | Verantwortung | Schnittstelle nach innen |
|---|---|---|
| **Viewport** | Canvas-Größe, DPR, Letterbox, Orientierungs-Gate, Pause | `ctx`-Transform, `paused` |
| **Input** | Tastatur und Touch → ein gemeinsames Zustandsobjekt | `input.up/left/right/action` |
| **Platform** | Audio-Unlock, Fullscreen, Vibration, Gesten-Sperre | einzelne Aufrufe |

Jeder Block ist ohne Kenntnis der Spiellogik verständlich und umgekehrt.

### Eingriffe in bestehenden Code

Nur vier, alle mechanisch:

1. `W`/`H` (Z. 75–76) werden feste Konstanten `800`/`500` statt
   `canvas.width`/`canvas.height`. **Das ist der kritische Schritt** — ohne ihn
   verschieben sich alle Level-Koordinaten, sobald der Canvas-Buffer wächst.
2. `update()` (Z. 352–354) liest `input.up/left/right` statt `keys["Arrow…"]`.
3. `handleInput()` (Z. 936) liest `input.action` statt `keys["Space"]`.
4. Die vier „PRESS SPACE …"-Textstellen (Z. 878, 901, 923 sowie beide
   `drawOverlay`-Aufrufe in Z. 675/678) gehen über eine Hilfsfunktion, die im
   Touch-Modus „TAP TO …" liefert.

## Komponenten im Detail

### Viewport

```
cssW/cssH  = größtes 8:5-Rechteck im verfügbaren Bereich
canvas.width  = cssW * devicePixelRatio
canvas.height = cssH * devicePixelRatio
ctx.setTransform(canvas.width/800, 0, 0, canvas.height/500, 0, 0)
```

Neu berechnet bei `resize`, `orientationchange` und `visualViewport.resize`,
gedrosselt über einen rAF-Tick.

**Bekannter Trade-off:** Bei nicht-ganzzahligem Skalierungsfaktor kantenglättet
der Browser `fillRect`-Kanten leicht. Die Schrift wird dafür deutlich schärfer
als bei reiner CSS-Streckung. Bewusst akzeptiert.

### Nachtrag: Desktop füllt jetzt das Fenster

Ursprünglich war die Desktop-Größe bei `Math.min(…, W)` und `Math.min(…, H)`
gedeckelt, das Spiel konnte also nie über 800×500 hinauswachsen. Beide
Deckelungen sind entfallen; Breite und Höhe ergeben sich ausschließlich aus dem
Fenster.

Statt der zuvor geschätzten 90 px wird das Beiwerk **gemessen**
(`instructions.offsetHeight` plus Rahmen und Rand): Die Hinweiszeile umbricht
bei schmalen Fenstern auf mehr Zeilen, ein fester Wert wäre dort falsch. Ein
Kreisbezug entsteht nicht, weil ihre Höhe nicht vom Canvas abhängt.

| Fenster | Canvas | Faktor |
|---|---|---|
| 1280×800 | 1164×728 | 1,46× |
| 1920×1080 | 1612×1008 | 2,02× |
| 2560×1440 | 2188×1368 | 2,74× |

**Auf 16:9-Monitoren bleiben Seitenränder.** Die Weltkoordinaten sind fest 8:5,
die Höhe ist auf Breitbild also immer der begrenzende Faktor — bei 1920×1080
sind das 154 px je Seite. Echtes Ausfüllen der Breite ginge nur durch Verzerren
oder durch ein breiteres Spielfeld, und Letzteres würde jede Pad-Koordinate in
allen fünf Levels verschieben.

**Pixelbudget:** `MAX_BACKING_PIXELS = 3840 × 2160`. Ohne diese Grenze ergäbe
ein 2560×1440-Retina-Display mit DPR 3 einen Puffer von 6564×4104 — 27
Megapixel, die jeden Frame komplett neu gefüllt werden, ohne sichtbaren Gewinn.
Auf einem normalen Retina-Laptop bleibt DPR 2 unangetastet.

### Orientierungs-Gate und Pause

`@media (orientation: portrait) and (pointer: coarse)` blendet ein Overlay
„BITTE GERÄT DREHEN" ein und setzt `paused = true`.

Dieselbe Pause greift bei `visibilitychange` und `blur` — sonst stürzt das Taxi
ab, während der Nutzer einen Anruf annimmt.

Beim Pausieren werden **alle Input-Flags zurückgesetzt**, sonst klemmt der Schub
nach der Rückkehr dauerhaft. Beim Fortsetzen wird der Delta-Time-Akkumulator
zurückgesetzt, damit kein Zeitsprung nachsimuliert wird.

Desktop ist von der Orientierungsregel nicht betroffen (`pointer: coarse`).

### Input

HTML-Overlay `#touch-controls` mit BEM-Klassen
`.touch-controls__btn--left/--right/--thrust`, aktiviert nur wenn
`matchMedia("(pointer: coarse)")` greift.

- **Pointer Events** statt Touch Events, mit globaler Map `pointerId → Button`.
  Bei `pointermove` wird per `elementFromPoint` neu zugeordnet, damit der Daumen
  von ◀ auf ▶ rutschen kann, ohne abzusetzen.
- **Kein `setPointerCapture`** — das würde genau dieses Rüberrutschen blockieren.
- `pointerup`, `pointercancel` und `lostpointercapture` lösen sauber aus.
- Buttons mindestens 56×56 CSS-px, Abstand über `env(safe-area-inset-*)`.
- Opazität ca. 45 % im Ruhezustand, höher beim Drücken.
- **Ausrichtung am Viewport-Rand, nicht am Canvas-Rand.** Auf breiten Geräten
  (21:9), wo ohnehin Letterbox-Streifen entstehen, wandern die Buttons dadurch
  von selbst aus dem Spielfeld heraus — ohne zweiten Layout-Pfad.

**Start/Weiter/Retry** = Tippen irgendwo auf das Spielfeld. Der Container hat
`pointer-events: none`, nur die Buttons `auto`.

Der Hinweistext unter dem Canvas (Z. 63) bekommt eine Touch-Variante.

### Delta-Time (Fixed-Timestep-Akkumulator)

```
STEP = 1000/60
acc += min(now - last, 5 * STEP)     // Clamp gegen Tab-Rückkehr-Sprünge
while (acc >= STEP) { update(); acc -= STEP }
draw()
```

Akkumulator statt `dt`-Multiplikator, weil dabei **keine einzige** bestehende
Konstante angefasst werden muss — weder `gravity: 0.04`, noch
`taxi.fuel -= 0.12`, noch die `levelTimer % 60`-Zähler oder `heyTimer > 150`.
Ein dt-Multiplikator würde rund 15 Konstanten und alle Modulo-Timer brechen.

Auf 120 Hz läuft die Physik danach exakt wie auf 60 Hz, nur das Rendering ist
doppelt so flüssig.

### Platform

- **Audio:** `ensureAudio()` und `audioCtx.resume()` bei jedem `pointerdown` und
  `keydown`, falls `audioCtx.state === "suspended"`. Zusätzlich `suspend`/`resume`
  an `visibilitychange`.
- **Gesten:** `viewport-fit=cover, user-scalable=no` im Meta-Tag;
  `touch-action: none`, `overscroll-behavior: none`,
  `-webkit-touch-callout: none`, `user-select: none` auf `html`/`body`.
- **Fullscreen:** ⛶-Button oben rechts, **nur eingeblendet wenn
  `document.documentElement.requestFullscreen` existiert.** iOS Safari
  unterstützt Element-Fullscreen nicht; dort wäre der Button ein toter Knopf.
- **Vibration:** `navigator.vibrate([60, 40, 120])` in `crash()`, guarded.
  **Nachtrag nach Test auf echtem iOS-Gerät:** `navigator.vibrate` existiert in
  Safari überhaupt nicht — WebKit hat die Vibration API nie implementiert, die
  Taptic Engine ist für Webinhalte unzugänglich. Der Guard greift also immer.
  Vibration ist auf iOS nicht lösbar; Details und die Diagnoseseite stehen im
  [Sound- und Haptik-Spec](2026-08-14-sound-and-haptics-design.md).

### Nebenbei-Fix

Das `e.preventDefault()` in Z. 130 feuert bei *jedem* Tastendruck und blockiert
damit F5, Cmd+R und Tab. Wird auf die tatsächlich genutzten Tasten eingegrenzt.
Betrifft die Datei, an der wir ohnehin arbeiten, und kostet eine Zeile.

## Fehlerbehandlung

| Fall | Verhalten |
|---|---|
| Finger verlässt Button, ohne loszulassen | `elementFromPoint` ordnet neu zu; verlässt er alle Buttons, wird der Schub beendet |
| App in den Hintergrund, Anruf | Pause, Input-Reset, Audio-Suspend |
| Rückkehr aus dem Hintergrund | Akkumulator-Reset, kein nachsimulierter Zeitsprung |
| Fullscreen-API fehlt (iOS) | Button wird nicht gerendert |
| `navigator.vibrate` fehlt | Aufruf übersprungen |
| AudioContext bleibt gesperrt | Spiel läuft stumm weiter, `try/catch` in `beep()` fängt bereits ab |
| Gerät im Hochformat | Overlay, Spiel pausiert |

## Verifikation

Im Projekt existiert kein Test-Framework, und ein Canvas-Spiel mit Multi-Touch
lässt sich sinnvoll nur interaktiv prüfen. Deshalb manuell und zweistufig:

**Durch Claude — Chrome-Device-Emulation und Konsole:**

- iPhone-Landscape und Android-Tablet, DPR 2 und 3 — Spielfeld vollständig
  sichtbar, korrektes Seitenverhältnis, keine Konsolenfehler
- Hochformat — Rotate-Overlay erscheint, Spiel pausiert
- Nach Orientierungswechsel — Canvas neu vermessen, Spielstand erhalten
- Buttons setzen `input`-Flags; Rüberrutschen zwischen ◀ und ▶ funktioniert
- Tastaturbedienung auf Desktop unverändert, F5 und Cmd+R wieder nutzbar
- Delta-Time: bei künstlich verdoppelter Framerate identische Fallgeschwindigkeit

**Durch den Nutzer auf echter Hardware — Emulation bildet das nicht ab:**

- Echtes Multi-Touch: Schub und Seitenschub gleichzeitig
- iOS-Audio-Policy: Ton nach dem ersten Tippen vorhanden
- Vibration beim Crash
- Fullscreen-Button (Android)
- Spielbarkeit: Sind die Buttons groß und gut erreichbar genug, verdecken sie
  die unteren Landepads zu stark?

Der letzte Punkt ist der einzige, der zu einer Nachjustierung führen kann —
Buttongröße, Position und Opazität sind bewusst als leicht änderbare Werte
angelegt.

## Bewusst nicht enthalten (YAGNI)

- Kein Build-Schritt, kein Framework, keine Aufteilung in mehrere Dateien
- Kein Neigungssensor, kein virtueller Joystick
- Keine eigene Mobile-Schwierigkeitsstufe
- Keine Offline-Fähigkeit, kein Service Worker, kein Web-App-Manifest
- Keine lokal eingebettete Schrift (der Google-Fonts-Import bleibt; ohne Netz
  greift die `monospace`-Fallback-Kette bereits)
- Kein Refactoring der Spiellogik über die vier genannten Eingriffe hinaus
