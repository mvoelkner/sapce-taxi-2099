# Space Taxi — Zufallsrouten, Passagier-Kollision, Fahrwerk

**Datum:** 2026-08-14
**Datei:** `index.html` (Single-File, kein Build-Schritt)
**Vorgänger:** [Mobile-Support](2026-08-14-mobile-support-design.md) — dieses Spec
setzt darauf auf und übernimmt dessen Fixed-Timestep-Schleife.
**Verwandt:** [Triebwerksklang, Sprachausgabe, Vibration](2026-08-14-sound-and-haptics-design.md)

## Ziel

Fünf Spielmechanik-Erweiterungen. Die ersten drei entstanden zusammen, Punkt 4
und 5 kamen später hinzu:

1. Zufällig ausgewürfelte Start-Ziel-Routen statt fest verdrahteter Fahrten
2. Landen **neben** dem Passagier — wer auf ihm landet, tötet ihn
3. Fahrwerk, das im Landeanflug ausklappt und ohne das keine Landung erlaubt
4. Tanken mit Fahrgast an Bord kostet ein Leben
5. Gesäter Zufall, damit ein ganzer Durchlauf reproduzierbar ist

## Ausgangslage

Vor dieser Änderung enthielt jedes der fünf Level ein festes
`passengers`-Array aus `{ padIndex, destPadIndex }`-Paaren. Fahrten liefen immer
in derselben Reihenfolge über dieselben Pads ab, also war ein Level nach dem
ersten Durchspielen auswendig lernbar.

Der Passagier stand grafisch mittig auf dem Pad (`pad.x + pad.w/2`) und hatte
keinerlei Kollision — das Taxi konnte ihn durchqueren. Das Fahrwerk war ein
statisches Detail im Sprite ohne Zustand.

## Entscheidungen

| Thema | Entscheidung |
|---|---|
| Routenform | Unabhängige Zufallspaare (Leerflüge zum nächsten Start eingeplant) |
| Passagier überfahren | Wie ein Crash: Leben verloren, Level neu |
| Einsteigen | Passagier läuft über das Pad zum Taxi |
| Fahrwerk | Spielrelevant: Aufsetzen ohne ausgefahrenes Fahrwerk ist ein Crash |
| Tanken mit Fahrgast | Wie ein Crash: Leben verloren, Level neu — aber trauriger Ton statt Explosion |

Alle vier Punkte wurden vor der Umsetzung explizit gewählt. Zum Fahrwerk war
angemerkt, dass eine harte Regel schwer zu durchschauen ist; die Entscheidung
für die harte Variante wurde bestätigt und ist unten entsprechend über eine
Sichtanzeige abgefedert.

## Architektur

Kein neues Modul. Die Änderungen liegen alle in der bestehenden Spielschleife
und ersetzen drei bisher implizite Zustände durch je einen expliziten:

| Vorher | Nachher |
|---|---|
| `LEVELS[].passengers: [{padIndex, destPadIndex}]` | `LEVELS[].fares: n` + Wurf in `initLevel()` |
| Vier Booleans `active`/`waiting`/`pickedUp`/`delivered` | Ein Feld `p.phase` |
| Fahrwerk als statische Pixel im Sprite | `taxi.gear` von 0 bis 1 |

Der Wechsel von vier Booleans auf ein `phase`-Feld ist der Kern: Erst dadurch
gibt es überhaupt einen Zustand „läuft gerade zum Taxi", und unmögliche
Kombinationen wie `pickedUp && waiting` können nicht mehr entstehen.

```
queued ──▶ waiting ──▶ boarding ──▶ aboard ──▶ delivered
              ▲            │
              └────────────┘
        Taxi hebt ab, bevor der
        Fahrgast eingestiegen ist
```

Zeitabhängige Größen (`GEAR_DEPLOY`, `GEAR_RETRACT`, `PERSON_WALK`) sind pro
1/60-Sekunden-Schritt definiert und damit konsistent mit dem Fixed-Timestep-
Akkumulator aus dem Mobile-Spec — auf 120 Hz laufen sie unverändert.

## Komponenten im Detail

### 1. Zufallsroute

```js
function randomFare(padCount) {
  const from = Math.floor(Math.random() * padCount);
  let to = Math.floor(Math.random() * (padCount - 1));
  if (to >= from) to++;      // nie zum Startpad liefern
  return { padIndex: from, destPadIndex: to };
}
```

Der `if (to >= from) to++`-Trick zieht gleichverteilt aus `padCount - 1`
Möglichkeiten und verschiebt dann über die Lücke. Das ist korrekter als eine
Neuziehungs-Schleife und terminiert garantiert.

Fahrten pro Level: 2 / 3 / 3 / 4 / 4 (unverändert zur früheren Anzahl). Start
und Ziel sind je Fahrt unabhängig gewürfelt, es entstehen also regelmäßig
Leerflüge zum nächsten Abholpad.

**Eine neue Route wird bei jedem `initLevel()` gewürfelt — auch nach einem
Crash.** Wer ein Level wiederholt, bekommt eine andere Route.

**Folgeanpassung an der Anzeige:** Der blinkende ▼-Marker zeigte bisher nur das
Ziel. Bei unabhängigen Paaren muss der Spieler aber auch das *Abhol*pad finden,
sonst wäre der Leerflug blindes Absuchen. Der Marker zeigt daher:

- grün über dem Abholpad, solange niemand an Bord ist
- gelb über dem Zielpad, sobald jemand mitfährt

### 2. Pads, Standposition und Kollision

Pads mussten Passagier **und** Taxi nebeneinander fassen. Breiten von 80–100 px
auf 115–130 px erhöht, einige Positionen verschoben, damit nichts über den
Spielfeldrand ragt oder unter einen Pfeiler gerät:

| Level | Pads (x / w) |
|---|---|
| 1 EASY CITY | 50/130, 350/130, 650/130 |
| 2 SKYSCRAPER | 20/130, 200/130, 440/130, 665/130 |
| 3 THE CAVERN | 30/120, 250/130, 500/115, 665/130 |
| 4 METROPLEX | 10/130, 160/115, 360/115, 515/130, 665/130 |
| 5 SPACE STATION | 12/120, 200/130, 400/120, 600/130, 660/130 |

Konstanten: `PERSON_HALF_W = 8` (halbe Sprite-Breite, Kollisionsbox),
`PERSON_MARGIN = 16` (Abstand zur Pad-Kante), `PERSON_WALK = 0.8` px/Schritt.

Der Passagier steht zufällig im linken oder rechten Drittel des Pads, damit der
Spieler vor dem Aufsetzen hinsehen muss.

**Die Standposition wird beim Aktivieren der Fahrt gewürfelt, nicht bei
Levelstart.** Das ist keine Stilfrage, sondern notwendig: Bei einer Route
`A→B` gefolgt von `B→C` steht das Taxi nach dem Absetzen noch auf B, wenn der
nächste Fahrgast dort erscheint. `passengerStandX(pad, avoidTaxi)` verwirft
deshalb Positionen innerhalb der Taxi-Silhouette und weicht auf die freie Seite
aus; sind beide Würfe blockiert, stellt sich der Fahrgast an die abgewandte
Deckkante.

Die Kollisionsbox ist `{ x: p.x - 8, y: pad.y - 14, w: 16, h: 14 }` und wird über
das vorhandene `rectOverlap` gegen das Taxi geprüft — **inklusive des
ausgefahrenen Fahrwerks**, dessen Streben sonst durch den Fahrgast greifen
würden. Geprüft wird nur in der Phase `waiting`, sonst würde der einsteigende
Fahrgast sich selbst am Taxi zerquetschen.

Treffer ⇒ `crash("PASSENGER CRUSHED!")`.

### 3. Einsteigen zu Fuß

Nach einer sauberen Landung auf dem Abholpad wechselt der Fahrgast nach
`boarding` und läuft mit 0,8 px pro Schritt auf `taxi.x + taxi.w/2` zu — bei
typischer Distanz rund eine Sekunde. Erst beim Erreichen der Tür gilt er als an
Bord (`sndPickup`, +10 Punkte, „TO PAD X!").

Hebt das Taxi vorher ab, wechselt er zurück nach `waiting` und bleibt stehen,
wo er gerade ist. Die Crush-Prüfung greift damit sofort wieder.

Das **Aussteigen bleibt bewusst sofortig** — der Wunsch bezog sich auf das
Landen neben dem *wartenden* Fahrgast. Ein symmetrischer Auslauf am Zielpad
wäre Zusatzarbeit ohne gestellte Anforderung.

### 4. Fahrwerk

```
GEAR_LEN     = 5     px, die die Streben unter den Rumpf reichen
GEAR_DEPLOY  = 1/20  ausfahren in ~0,33 s
GEAR_RETRACT = 1/45  einfahren deutlich langsamer
GEAR_ZONE_X  = 30    seitlicher Spielraum um eine Landefläche
GEAR_ZONE_Y  = 90    Höhe darüber, ab der ausgefahren wird
```

`nearLandingSurface()` prüft Pads **und** Tankstellen. `taxi.gear` läuft
zwischen 0 und 1; `gearDrop = GEAR_LEN * taxi.gear` geht in Landeerkennung und
Kollisionsbox ein.

Landung nur bei `taxi.gear >= 1`, sonst `crash("GEAR NOT DOWN!")`. Die Prüfung
steht **vor** der Geschwindigkeitsprüfung, damit ein Sturzflug die aussagekräftigere
Meldung liefert.

Die Ruheposition liegt jetzt auf den Füßen statt auf dem Rumpf:
`taxi.y = pad.y - taxi.h - GEAR_LEN`. Die Kollisionsbox gegen Hindernisse bleibt
bei 32×18 — die Streben sind zu dünn, um dafür ins Gewicht zu fallen.

**Kalibrierung, offen zur Nachjustierung:** Aus 90 px Höhe braucht ein Taxi bei
der maximal erlaubten Landegeschwindigkeit (1,8 px/Schritt) etwa 50 Schritte bis
zum Deck, das Ausfahren dauert 20. Die Regel greift daher praktisch nur bei
echten Sturzflügen, die an der Geschwindigkeitsprüfung ohnehin scheitern würden,
sowie bei schnellen seitlichen Anflügen, die spät in die Zone eintreten. Sie
wirkt damit eher als Sicherheitsnetz denn als Falle. Wer sie schärfer will,
verkleinert `GEAR_ZONE_Y`.

**Sichtbarkeit der Regel** — gegen die Kritik, eine harte Fahrwerksregel sei
schwer zu durchschauen:

- Streben zeichnen sich grau, solange sie ausfahren, und hellgrau, sobald
  verriegelt
- HUD zeigt mittig `GEAR UP` / `GEAR DOWN`, farbcodiert
- Titelbildschirm nennt die Regel ausdrücklich

### 5. Landeflächen, gemeinsam behandelt

Pads und Tankstellen sind beide flache Flächen, auf denen das Taxi aufsetzt, und
jede Regel gilt für beide. Ursprünglich stand die Logik zweimal da — was sich
dreimal gerächt hat: Fahrwerksprüfung, Ruheposition auf den Füßen und
Aufsetz-Feedback mussten jeweils **doppelt** eingebaut werden.

`tryTouchdown(surface, snap, gearDrop, wasAirborne)` liefert
`"none" | "crash" | "land"`; bei `"crash"` bricht der Aufrufer den Schritt ab.
Gemeinsam sind Fahrwerksgate, Geschwindigkeitsgrenzen, Aufsetz-Feedback und
Ruheposition. Unterschiedlich bleibt nur, was wirklich unterschiedlich ist:

```
MAX_LAND_VY = 1.8    schneller ist ein Wrack
MAX_LAND_VX = 1.5
PAD_SNAP    = 12     Kontakttoleranz unter der Deckkante
FUEL_SNAP   = 14     Tankstellen sind etwas nachsichtiger
```

Die beiden Toleranzen unterscheiden sich seit dem Original ohne erkennbaren
Grund; sie wurden bewusst beibehalten, um kein Spielverhalten mitzuändern.

Der Nutzen liegt in der Divergenzsicherheit, nicht in der Länge: netto etwa
zehn Zeilen weniger.

### 6. Tanken mit Fahrgast

Landet das Taxi mit Fahrgast auf einer Tankstelle **und fließt tatsächlich
Sprit** (`taxi.fuel < taxi.maxFuel`), kostet das ein Leben. Wer mit vollem Tank
aufsetzt, wird nicht bestraft — „tanken" heißt Sprit aufnehmen, nicht daneben
stehen.

`crash()` und die neue `refuelViolation()` teilen sich `loseLife(reason)`:
Lebensabzug, Zustandswechsel und das Zurücksetzen der Rumble-Flags stehen nur
noch an einer Stelle. Der Unterschied liegt in der Präsentation — kein
Explosionsgeräusch, keine Partikel, stattdessen `sndSad()` (drei absteigende
Töne plus eine vierte, die per Frequenzrampe von 262 auf 150 Hz absackt) und
Vibration `[180]`.

**Die Regel ist sichtbar, bevor sie zuschlägt.** Solange jemand mitfährt, wird
die Tankstelle rot gezeichnet und beschriftet sich mit `NO FUEL` statt `FUEL`.
Ohne das ließe sie sich ausschließlich durch ein verlorenes Leben lernen.
Zusätzlich je eine Zeile auf dem Titelbildschirm und unter dem Canvas.

### 7. Gesäter Zufall

Alles, was den Ausgang eines Laufs beeinflusst, zieht aus `rng()` (mulberry32),
nie aus `Math.random()`. Betroffen sind `randomFare` und `passengerStandX`.

**Die 19 rein optischen `Math.random()`-Aufrufe** (Partikel, Flammen, Sterne)
bleiben bewusst ungesät: Sie laufen pro *gezeichnetem* Frame und würden die
Sequenz von der Bildwiederholrate abhängig machen — also genau den Determinismus
zerstören, um den es geht.

Ein `runSeed` bestimmt einen ganzen Durchlauf:

```js
rngState = (runSeed + Math.imul(++initCount, 0x9E3779B9)) | 0;
```

Der Zähler `initCount` läuft bei jedem `initLevel()` weiter. Dadurch bleibt das
bisherige Verhalten erhalten — **ein Retry würfelt weiterhin eine neue Route** —
während der Lauf als Ganzes von einem Seed aus reproduzierbar ist. Ohne den
Zähler hätte ein Retry stets dieselbe Route geliefert, was eine frühere
Entscheidung stillschweigend umgekehrt hätte.

`?seed=<zahl>` in der URL wiederholt einen Lauf exakt; `?seed=0` ist ein gültiger
Seed und wird nicht als falsy verworfen. Ungültige Eingaben fallen auf Zufall
zurück. Der aktuelle Seed steht klein auf dem Titelbildschirm.

Der Nutzen ist nicht nur ein möglicher Mehrspielermodus: Sporadische
Testfehlschläge, die zuvor über 25 Wiederholungen eingefangen werden mussten,
sind nun über eine Seed-Zahl exakt wiederholbar.

### 8. Crash-Gründe

`crash()` nimmt einen Grund entgegen (`crash(reason = "CRASHED!")`) und legt ihn
in `crashReason` ab; das Overlay zeigt ihn statt des festen Textes. Bestehende
Aufrufe bleiben unverändert gültig.

## Fehlerbehandlung

| Fall | Verhalten |
|---|---|
| Taxi landet auf dem wartenden Fahrgast | Crash „PASSENGER CRUSHED!", Leben weg |
| Aufsetzen mit nicht verriegeltem Fahrwerk | Crash „GEAR NOT DOWN!", Leben weg |
| Tanken mit Fahrgast an Bord | „NO REFUELLING WITH A FARE!", Leben weg, trauriger Ton |
| Tankstelle mit vollem Tank berührt | keine Strafe, es fließt kein Sprit |
| Taxi hebt während des Einsteigens ab | Fahrgast kehrt nach `waiting` zurück |
| Nächste Fahrt startet auf dem Pad, auf dem das Taxi parkt | Standposition weicht der Silhouette aus |
| Beide Standpositionen blockiert | Fahrgast stellt sich an die abgewandte Deckkante |
| Fahrgast erreicht die Tür nie (Taxi weggerutscht) | `boarding` bricht ab, Crush-Prüfung wieder aktiv |
| Letztes Leben verloren | `gameOver` statt Levelneustart, für beide Verlustpfade |

## Gefundene und behobene Fehler

Alle drei fielen erst in der Verifikation auf, nicht beim Schreiben:

**Pad D in Level 4 war unspielbar geworden.** Durch die Verbreiterung reichte es
unter den Pfeiler bei `x:650`, dessen Unterkante nur 20 px über dem Deck endet —
zu wenig für ein 18 px hohes Taxi samt Fahrwerk. Ein dort platzierter Fahrgast
wäre unerreichbar gewesen. Pad von `x:550` auf `x:515` verschoben.

**Rund 20 % der Zufallsrouten enthielten einen unvermeidbaren Tod.** Bei der
Folge `A→B`, `B→C` erschien der nächste Fahrgast auf Pad B teils unter dem noch
dort geparkten Taxi — sofortiger Crush ohne Zutun des Spielers. Ursache war die
zu frühe Festlegung aller Standpositionen bei Levelstart. Behoben durch den
Wurf zum Aktivierungszeitpunkt (siehe oben).

**Die Seitentriebwerke bliesen durch den eigenen Rumpf.** Die Partikel-
*Geschwindigkeiten* waren physikalisch richtig (Schub nach links → Abgas nach
rechts), aber Austrittsposition und Flamme saßen auf der Seite der
Bewegungsrichtung. Beide wandern jetzt auf die Gegenseite. Ein Test prüft für
jede Richtung, dass Position **und** Geschwindigkeit übereinstimmen — genau ihr
Widerspruch war der Fehler.

## Verifikation

Zwei Prüfungen, beide automatisiert:

**Geometrie-Check** über die `LEVELS`-Daten: Pads innerhalb des Spielfelds,
keine Überschneidung mit Hindernissen, freier Anflugkorridor von
`taxi.h + GEAR_LEN` über jedem Deck, ausreichende Standspanne für den Fahrgast.
Dieser Check fand den Pad-D-Fehler.

**Verhaltens-Harness**: Das echte Spielskript läuft kopflos in Node gegen
DOM-Stubs, die IIFE-Internas werden für den Test freigelegt. Inzwischen
98 Prüfungen über Routenverteilung und Seed-Reproduzierbarkeit,
Crush-Erkennung, Fahrwerkszyklus, abgebrochenes Einsteigen, Ruheposition auf den
Füßen, Tank-Regel, Triebwerksrichtung, Ton und Vibration, Desktop-Skalierung und
`draw()` in allen sechs Spielzuständen — plus 1000 vollständige
Level-Durchläufe (5 Level × 200 Zufallsrouten) mit der Zusicherung, dass jede
gewürfelte Route lösbar ist. Dieser Lauf fand den Spawn-Fehler.

Zwei fehlerhafte Testszenarien im ersten Lauf waren falsche Annahmen im Test,
nicht Fehler im Spiel: eine vermeintlich „freie" Testposition lag genau über der
Tankstelle von Level 1, und ein gestellter Frame rechnete die Landehöhe für
volles statt halb ausgefahrenes Fahrwerk. Beide wurden durch ehrlichere
Szenarien ersetzt — ein echter Sturzflug statt einer gesetzten Position.

**Später kamen drei latent flakige Tests ans Licht**, die nur zufällig nie
aufgetreten waren. Zwei suchten den Fahrgast über `padIndex` allein und trafen
dabei manchmal eine noch nicht aktivierte Fahrt — die haben seit dem Spawn-Fix
kein `x`, das Taxi wurde also auf Koordinate 0 gesetzt. Der dritte landete
mittig auf dem Pad, ohne den Fahrgast zu meiden; der resultierende
`PASSENGER CRUSHED!` war das Spiel, das korrekt arbeitet. Die Platzsuche steckt
jetzt in einer gemeinsamen Hilfsfunktion `clearSpotOn(padIdx)`, die alle fünf
Teststellen nutzen — vorher stand dieselbe Rechnung viermal leicht abweichend
im Harness.

**Performance wurde gemessen, nicht optimiert.** `update()` kostet 0,0075 ms,
`draw()` 0,0206 ms — zusammen 0,17 % des 16,7-ms-Budgets bei 60 Hz. Der
JavaScript-Anteil ist damit bedeutungslos; Optimierungen würden Lesbarkeit gegen
nichts eintauschen. Realer Kostentreiber ist allein die Füllrate: 260 `fillRect`
plus Vollbild-Clear, dazu 143 `globalAlpha`- und 188 `fillStyle`-Zuweisungen pro
Frame. Falls es je klemmt, sind die Zustandswechsel die erste Stelle.

### Einschränkungen

**Der Harness liegt im Scratchpad, nicht im Projekt.** Er ist damit ein
Einmal-Werkzeug und läuft bei künftigen Änderungen nicht erneut. Ihn ins
Repository zu übernehmen wäre die naheliegende Verbesserung, ist aber bewusst
nicht Teil dieser Änderung.

**Nicht automatisiert prüfbar ist das Spielgefühl** — ob die Gehzeit von rund
einer Sekunde träge wirkt, ob 130 px breite Pads das Leveldesign zu luftig
machen und ob die Fahrwerksregel spürbar genug ist. Das bleibt am Spieltest.

## Ausblick: Mehrspieler

Eine Mehrspieleroption wurde geprüft, aber **nicht** vorbereitet, solange das
Modell offen ist. Der Befund als Notiz für später:

**Bereits vorhanden:** Der Fixed-Timestep-Akkumulator ist die wichtigste
Voraussetzung überhaupt. Weltkoordinaten sind fest 800×500. Eingaben laufen über
ein `input`-Objekt statt direkt über `keys`. Und seit dem gesäten Zufall ist die
Simulation reproduzierbar.

**Vier Blocker, in aufsteigendem Aufwand:**

1. Präsentation feuert direkt aus `update()` — 16 Aufrufstellen von `sndPickup`,
   `crash`, `touchdownFeedback`, `vibrate`. Bei Neusimulation oder Simulation
   entfernter Spieler spielen Töne doppelt oder für den falschen Spieler. Braucht
   eine Ereignisliste, die die Darstellung abräumt.
2. Das Fahrten-Modell ist auf ein Taxi ausgelegt: sequenzielle Freigabe über
   `passengers[p.index-1].phase === "delivered"`, `hasPassenger` als einzelnes
   Boolean. Konkurrierende Taxis bräuchten beanspruchbare Fahrten.
3. `state` vermischt „dieser Spieler ist abgestürzt" mit „das Level ist vorbei".
4. Ein globales `taxi` plus globales `input`; `update()` greift rund 40-mal
   darauf zu. Braucht `updateShip(ship, input)`.

**Das Modell entscheidet die Priorität:** Lokaler Splitscreen braucht nur
Blocker 2 und 4 — Determinismus ist dort irrelevant. Online-Lockstep braucht den
gesäten Zufall (erledigt). Server-autoritativ mit Vorhersage braucht Blocker 1.

## Bewusst nicht enthalten (YAGNI)

- Kein Auslaufen des Fahrgasts am Zielpad
- Keine Gewichtung der Zufallsrouten (weite Strecken sind nicht seltener)
- Keine Garantie, dass eine Route alle Pads besucht
- Kein manuelles Ausfahren des Fahrwerks per Taste
- Keine Anpassung von Spritverbrauch oder Punkten an die neuen Leerflüge
- Keine Mehrspieler-Vorbereitung über den gesäten Zufall hinaus
- Kein Seed-Eingabefeld im Spiel (nur über `?seed=` in der URL)
