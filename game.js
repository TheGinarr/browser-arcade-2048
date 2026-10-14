/* ============================================================
   2048 · game.js
   ------------------------------------------------------------
   SO FUNKTIONIERT DIESES SPIEL
   1. Die Spiellogik besteht aus REINEN Funktionen (oben in der
      Datei): schiebeZeileLinks(), zugBerechnen() usw. Sie kennen
      weder DOM noch Browser – sie bekommen Zahlen und liefern
      Zahlen. Dadurch kann man sie in Node testen.
   2. Das Brett ist ein 4x4-Array aus Zahlen (0 = leeres Feld).
      Das ist die "Wahrheit" des Spiels; Anzeige und Speicherstand
      werden daraus abgeleitet.
   3. Gerendert wird mit DOM-Elementen (nicht Canvas): Jede Kachel
      ist ein eigenes <div> über dem Hintergrund-Grid. Der Browser
      animiert Position (transition) und Effekte (keyframes) dann
      von selbst – wir ändern nur CSS-Variablen und Klassen.
   4. Ein Zug: Taste/Wischen → zugBerechnen() → Kacheln werden
      "umgehängt" (neue Positionen, Verschmelzungen) → neue Kachel
      → HUD + Speichern → Prüfung auf 2048 / Spielende.
   5. Der Zustand "phase" ("spielt", "hinweis", "vorbei") sperrt
      Eingaben, wenn gerade ein Overlay oder Dialog offen ist.
   6. Alles weitere (Speicherstand, Topliste, Game-Over-Dialog)
      kommt aus ../assets/storage.js und ../assets/ui.js.
   ============================================================ */

import {
  bewegungReduziert,
  zahlHochzaehlen,
  toplisteAnzeigen,
  gameOverDialog,
} from "./assets/ui.js";
import { lade, speichere, entferne, spielZuruecksetzen, topliste } from "./assets/storage.js";

const SPIEL = "2048"; // Schlüssel für storage.js (Ordner im localStorage)
const GROESSE = 4; // 4x4-Brett
const SCHIEBE_MS = 110; // Gleitdauer; muss zu --schiebe in spiel.css passen
const WISCH_MINDESTWEG = 24; // ab so vielen Pixeln zählt eine Bewegung als Wischen

/* ============================================================
   TEIL 1: REINE SPIELLOGIK (ohne DOM)
   Das "export" steht nur da, damit Tests (Node) die Funktionen
   importieren können. Im Browser wird es nicht gebraucht.
   ============================================================ */

/**
 * Schiebt EINE Zeile nach links und verschmilzt gleiche Nachbarn.
 *
 * Idee: Wir gehen die Zahlen von links nach rechts durch und bauen
 * eine neue Liste ("teile"). Eine 0 überspringen wir einfach – das
 * ist schon das "Zusammenschieben". Ist die aktuelle Zahl gleich
 * dem letzten Teil, verschmelzen wir beide.
 *
 * WICHTIG – jede Kachel verschmilzt pro Zug nur EINMAL:
 * Das Flag "verschmolzen" verhindert, dass aus [2,2,4] erst [4,4]
 * und dann gleich [8] wird. Richtig ist [4,4].
 *
 * Rückgabe:
 *   ergebnis  die neue Zeile, aufgefüllt mit Nullen
 *   punkte    Summe der entstandenen Verschmelzungswerte
 *   herkunft  zu jedem Ergebnisfeld: aus welchen alten Positionen
 *             es entstanden ist (1 Index = verschoben, 2 = verschmolzen).
 *             Das brauchen wir später, um die richtigen Kacheln zu animieren.
 *   bewegt    true, wenn sich überhaupt etwas geändert hat
 */
export function schiebeZeileLinks(werte) {
  const teile = [];
  let punkte = 0;

  werte.forEach((wert, index) => {
    if (wert === 0) return; // leere Felder ignorieren
    const letztes = teile[teile.length - 1];
    if (letztes && !letztes.verschmolzen && letztes.wert === wert) {
      letztes.wert *= 2; // verschmelzen
      letztes.verschmolzen = true; // ab jetzt gesperrt für diesen Zug
      letztes.quellen.push(index);
      punkte += letztes.wert; // Standard-Regel: neuer Wert zählt als Punkte
    } else {
      teile.push({ wert, verschmolzen: false, quellen: [index] });
    }
  });

  const ergebnis = teile.map((t) => t.wert);
  while (ergebnis.length < werte.length) ergebnis.push(0); // rechts mit Nullen auffüllen

  const bewegt = ergebnis.some((w, i) => w !== werte[i]);
  return { ergebnis, punkte, herkunft: teile.map((t) => t.quellen), bewegt };
}

/**
 * Liefert die vier "Linien" (Zeilen oder Spalten) für eine Richtung.
 * Jede Linie ist eine Liste von [zeile, spalte]-Koordinaten, und zwar
 * so geordnet, dass die ZIELSEITE der Bewegung immer vorne (Index 0) liegt.
 *
 * WARUM? So reicht EINE Funktion (schiebeZeileLinks) für alle vier
 * Richtungen: "nach rechts schieben" ist nichts anderes als "die Zeile
 * umgedreht lesen und nach links schieben". Kein Code-Duplikat, keine
 * vier fast gleichen Schleifen.
 */
export function linienFuer(richtung, groesse = GROESSE) {
  const reihe = Array.from({ length: groesse }, (_, i) => i); // [0,1,2,3]
  const umgekehrt = [...reihe].reverse(); // [3,2,1,0]
  return reihe.map((n) => {
    switch (richtung) {
      case "links":
        return reihe.map((i) => [n, i]); // Zeile n, von links nach rechts
      case "rechts":
        return umgekehrt.map((i) => [n, i]); // Zeile n, von rechts nach links
      case "hoch":
        return reihe.map((i) => [i, n]); // Spalte n, von oben nach unten
      case "runter":
        return umgekehrt.map((i) => [i, n]); // Spalte n, von unten nach oben
      default:
        throw new Error(`Unbekannte Richtung: ${richtung}`);
    }
  });
}

/** Erzeugt ein leeres Brett (oder eine Kachel-Matrix) mit einem Füllwert. */
export function leeresBrett(fuellwert = 0, groesse = GROESSE) {
  return Array.from({ length: groesse }, () => Array(groesse).fill(fuellwert));
}

/**
 * Berechnet einen kompletten Zug. Verändert das übergebene Brett NICHT,
 * sondern liefert ein neues (reine Funktion → keine versteckten Nebeneffekte).
 *
 * Rückgabe:
 *   neuesBrett   das Brett nach dem Zug (noch ohne neue Kachel)
 *   punkte       Punkte dieses Zuges
 *   bewegt       false = Zug war wirkungslos (zählt nicht, keine neue Kachel!)
 *   bewegungen   Liste { nach:[z,s], wert, quellen:[[z,s], …] } pro belegtem
 *                Zielfeld – die Anleitung für die Animation
 */
export function zugBerechnen(brett, richtung) {
  const neuesBrett = leeresBrett(0, brett.length);
  const bewegungen = [];
  let punkte = 0;
  let bewegt = false;

  for (const linie of linienFuer(richtung, brett.length)) {
    const werte = linie.map(([z, s]) => brett[z][s]);
    const r = schiebeZeileLinks(werte);

    // Ergebnis zurück an die richtigen Koordinaten schreiben
    r.ergebnis.forEach((wert, k) => {
      const [z, s] = linie[k];
      neuesBrett[z][s] = wert;
    });
    // Herkunft ebenfalls in echte Koordinaten übersetzen
    r.herkunft.forEach((quellenIndizes, k) => {
      bewegungen.push({
        nach: linie[k],
        wert: r.ergebnis[k],
        quellen: quellenIndizes.map((i) => linie[i]),
      });
    });

    punkte += r.punkte;
    if (r.bewegt) bewegt = true;
  }
  return { neuesBrett, punkte, bewegt, bewegungen };
}

/** Alle freien Felder als [zeile, spalte]-Liste. */
export function freieFelder(brett) {
  const frei = [];
  brett.forEach((zeile, z) =>
    zeile.forEach((wert, s) => {
      if (wert === 0) frei.push([z, s]);
    }),
  );
  return frei;
}

/**
 * Gibt es noch einen möglichen Zug? Ja, wenn ein Feld frei ist
 * ODER zwei gleiche Zahlen nebeneinander (rechts/unten reicht –
 * links/oben würde dieselben Paare nur doppelt prüfen).
 */
export function zugMoeglich(brett) {
  if (freieFelder(brett).length > 0) return true;
  for (let z = 0; z < brett.length; z++) {
    for (let s = 0; s < brett.length; s++) {
      const wert = brett[z][s];
      if (s + 1 < brett.length && brett[z][s + 1] === wert) return true;
      if (z + 1 < brett.length && brett[z + 1][s] === wert) return true;
    }
  }
  return false;
}

/**
 * Wählt ein zufälliges freies Feld und einen Wert (90 % eine 2, 10 % eine 4).
 * `zufall` ist austauschbar (Standard Math.random) – so lässt sich die
 * Funktion mit festen Zahlen testen. Gibt null zurück, wenn nichts frei ist.
 */
export function zufaelligeNeueKachel(brett, zufall = Math.random) {
  const frei = freieFelder(brett);
  if (frei.length === 0) return null;
  const [z, s] = frei[Math.floor(zufall() * frei.length)];
  return { z, s, wert: zufall() < 0.9 ? 2 : 4 };
}

/** Höchster Wert auf dem Brett. */
export function hoechsteKachel(brett) {
  return Math.max(...brett.flat());
}

/* ============================================================
   TEIL 2: DARSTELLUNGS-HILFEN (Klassennamen)
   ============================================================ */

/** CSS-Klasse für die Farbe: kachel-2 … kachel-2048, darüber kachel-gross. */
function farbKlasse(wert) {
  return wert <= 2048 ? `kachel-${wert}` : "kachel-gross";
}

/** CSS-Klasse für die Schriftgröße: "ziffern-3" bei 128, "ziffern-4" bei 1024 … */
function ziffernKlasse(wert) {
  const stellen = String(wert).length;
  return stellen >= 3 ? `ziffern-${Math.min(stellen, 6)}` : "";
}

/* ============================================================
   TEIL 3: SPEICHERSTAND LESEN (mit Prüfung)
   ============================================================ */

/** Ist das ein erlaubter Feldwert? 0 oder eine Zweierpotenz ab 2. */
function istGueltigerWert(wert) {
  return (
    wert === 0 ||
    (Number.isInteger(wert) && wert >= 2 && wert <= 2 ** 17 && Number.isInteger(Math.log2(wert)))
  );
}

/**
 * Liest den gespeicherten Spielstand und prüft ihn GRÜNDLICH.
 * WARUM? Der localStorage ist von außen veränderbar (Entwicklertools,
 * alte Versionen, Fehler). Würden wir blind vertrauen, könnte ein
 * kaputter Eintrag das Spiel für immer lahmlegen. Lieber verwerfen
 * und neu starten. Gibt null zurück, wenn nichts Brauchbares da ist.
 */
function spielstandLesen() {
  const roh = lade(SPIEL, "spielstand", null);
  if (!roh || !Array.isArray(roh.brett) || roh.brett.length !== GROESSE) return null;

  for (const zeile of roh.brett) {
    if (!Array.isArray(zeile) || zeile.length !== GROESSE) return null;
    if (!zeile.every(istGueltigerWert)) return null;
  }
  if (!Number.isInteger(roh.punkte) || roh.punkte < 0) return null;
  if (!zugMoeglich(roh.brett)) return null; // ein "totes" Brett nicht fortsetzen
  if (freieFelder(roh.brett).length === GROESSE * GROESSE) return null; // leeres Brett ist sinnlos

  return {
    brett: roh.brett.map((zeile) => [...zeile]), // Kopie, nicht das geladene Objekt
    punkte: roh.punkte,
    hinweisGezeigt: roh.hinweisGezeigt === true,
  };
}

/* ============================================================
   TEIL 4: DAS SPIEL IM BROWSER
   Alles ab hier braucht DOM und läuft in starteSpiel().
   ============================================================ */

function starteSpiel() {
  // ----- Elemente einmal suchen und merken -----
  const brettElement = document.getElementById("brett");
  const ebene = document.getElementById("kacheln");
  const punkteElement = document.getElementById("hud-punkte");
  const besterElement = document.getElementById("hud-bester");
  const toplisteElement = document.getElementById("topliste");
  const overlay = document.getElementById("overlay");
  const ansageElement = document.getElementById("ansage");

  // ----- Spielzustand -----
  let brett = leeresBrett(0); // Zahlen: die "Wahrheit"
  let kacheln = leeresBrett(null); // gleiche Form, aber mit Kachel-Objekten (DOM-Seite)
  let punkte = 0;
  let hinweisGezeigt = false; // "2048 erreicht"-Hinweis nur EINMAL pro Spiel
  let phase = "spielt"; // "spielt" | "hinweis" | "vorbei"
  let runde = 0; // zählt Neustarts hoch (siehe verzoegert())

  /**
   * Führt `aktion` nach `ms` Millisekunden aus – aber NUR, wenn
   * inzwischen kein neues Spiel gestartet wurde. Sonst könnte z. B.
   * ein Game-Over-Dialog des alten Spiels mitten im neuen auftauchen.
   */
  function verzoegert(aktion, ms) {
    const meineRunde = runde;
    setTimeout(() => {
      if (meineRunde === runde) aktion();
    }, ms);
  }

  /** Wartezeit für Animationen; bei reduzierter Bewegung entfällt sie. */
  function animationsZeit(ms) {
    return bewegungReduziert() ? 0 : ms;
  }

  function ansagen(text) {
    ansageElement.textContent = text;
  }

  // ---------------------------------------------------------
  // Kacheln (DOM)
  // ---------------------------------------------------------

  /**
   * WARUM ist jede Kachel ein eigenes Element ÜBER dem Grid?
   * Würden wir die Zahlen direkt in die 16 Grid-Zellen schreiben,
   * ließe sich nichts animieren: Eine Zahl, die von Zelle 3 nach
   * Zelle 0 "wandert", würde in Wahrheit nur in Zelle 3 verschwinden
   * und in Zelle 0 auftauchen. Ein eigenes Element dagegen behält
   * seine Identität; wir ändern nur seine Position (--z, --s), und die
   * CSS-Transition gleitet es weich dorthin.
   */
  function kachelErzeugen(z, s, wert, mitPop) {
    const el = document.createElement("div");
    el.className = "kachel";
    const innen = document.createElement("div"); // trägt Farbe, Zahl und Effekte
    el.append(innen);

    const kachel = { z, s, wert, el, innen };
    kachelDarstellen(kachel);
    positionSetzen(kachel);
    if (mitPop) innen.classList.add("pop");
    ebene.append(el);
    return kachel;
  }

  /** Setzt Zahl, Farbe und Schriftgröße einer Kachel passend zu ihrem Wert. */
  function kachelDarstellen(kachel) {
    kachel.innen.className =
      `kachel-innen ${farbKlasse(kachel.wert)} ${ziffernKlasse(kachel.wert)}`.trim();
    kachel.innen.textContent = kachel.wert; // textContent: nie innerHTML mit Werten mischen
  }

  /** Schreibt Zeile/Spalte als CSS-Variablen; das CSS rechnet daraus den translate-Wert. */
  function positionSetzen(kachel) {
    kachel.el.style.setProperty("--z", kachel.z);
    kachel.el.style.setProperty("--s", kachel.s);
  }

  /** Baut alle Kacheln passend zum Zahlen-Brett neu auf (Start / Laden). */
  function kachelnNeuAufbauen(mitPop) {
    ebene.replaceChildren();
    kacheln = leeresBrett(null);
    brett.forEach((zeile, z) =>
      zeile.forEach((wert, s) => {
        if (wert !== 0) kacheln[z][s] = kachelErzeugen(z, s, wert, mitPop);
      }),
    );
  }

  // ---------------------------------------------------------
  // HUD, Topliste, Speichern
  // ---------------------------------------------------------

  function besterWert() {
    // Die Topliste ist absteigend sortiert → Platz 1 ist der beste Eintrag.
    return topliste(SPIEL)[0]?.punkte ?? 0;
  }

  function seiteAktualisieren() {
    besterElement.textContent = besterWert();
    toplisteAnzeigen(toplisteElement, SPIEL, (p) => `${p} Punkte`);
  }

  function spielstandSichern() {
    speichere(SPIEL, "spielstand", { brett, punkte, hinweisGezeigt });
  }

  // ---------------------------------------------------------
  // Spielablauf
  // ---------------------------------------------------------

  function neuesSpiel() {
    runde++; // alle wartenden Timer des alten Spiels ungültig machen
    brett = leeresBrett(0);
    punkte = 0;
    hinweisGezeigt = false;
    phase = "spielt";
    overlay.classList.remove("sichtbar");

    // Zwei Startkacheln
    for (let i = 0; i < 2; i++) {
      const neu = zufaelligeNeueKachel(brett);
      brett[neu.z][neu.s] = neu.wert;
    }
    kachelnNeuAufbauen(true);

    zahlHochzaehlen(punkteElement, 0);
    seiteAktualisieren();
    spielstandSichern();
    ansagen("Neues Spiel gestartet.");
  }

  /** Setzt ein gespeichertes Spiel fort (Daten wurden vorher geprüft). */
  function spielstandFortsetzen(stand) {
    runde++;
    brett = stand.brett;
    punkte = stand.punkte;
    hinweisGezeigt = stand.hinweisGezeigt;
    phase = "spielt";
    kachelnNeuAufbauen(false); // beim Fortsetzen ohne Pop-Effekt
    punkteElement.textContent = punkte; // direkt setzen, kein Hochzählen nötig
    seiteAktualisieren();
  }

  /**
   * Ein kompletter Zug. Reihenfolge:
   *   1. rechnen (pure Funktion)   2. Kacheln umhängen/animieren
   *   3. neue Kachel               4. HUD + Speichern
   *   5. Gewinn-/Verlust-Prüfung
   */
  function zugAusfuehren(richtung) {
    if (phase !== "spielt") return;

    const zug = zugBerechnen(brett, richtung);
    if (!zug.bewegt) return; // wirkungsloser Zug: nichts passiert (wie im Original)

    // --- 2. Kacheln umhängen -------------------------------
    // Wir bauen eine NEUE Kachel-Matrix, statt die alte zu verändern:
    // Beim Umhängen würden sonst Kacheln auf Felder geschrieben, aus
    // denen wir gerade noch lesen wollen.
    const neueKacheln = leeresBrett(null);
    const verschmolzene = []; // { haupt, zweite } je Verschmelzung

    for (const b of zug.bewegungen) {
      const [nz, ns] = b.nach;
      const [hz, hs] = b.quellen[0];
      const haupt = kacheln[hz][hs];
      haupt.z = nz;
      haupt.s = ns;
      positionSetzen(haupt); // CSS-Transition gleitet die Kachel dorthin

      if (b.quellen.length === 2) {
        // Zwei Kacheln treffen sich: die zweite gleitet ebenfalls auf das Zielfeld ...
        const [zz, zs] = b.quellen[1];
        const zweite = kacheln[zz][zs];
        zweite.z = nz;
        zweite.s = ns;
        positionSetzen(zweite);
        haupt.wert = b.wert; // Modell sofort aktualisieren ...
        verschmolzene.push({ haupt, zweite }); // ... Darstellung folgt nach dem Gleiten
      }
      neueKacheln[nz][ns] = haupt;
    }
    kacheln = neueKacheln;

    // ... und erst NACH dem Gleiten wird die zweite Kachel entfernt und die
    // erste zeigt den neuen Wert mit Puls. So sieht man, wie sie verschmelzen.
    if (verschmolzene.length > 0) {
      verzoegert(() => {
        for (const { haupt, zweite } of verschmolzene) {
          zweite.el.remove();
          kachelDarstellen(haupt); // setzt className neu → Puls startet frisch
          haupt.innen.classList.add("puls");
        }
      }, animationsZeit(SCHIEBE_MS));
    }

    brett = zug.neuesBrett;
    punkte += zug.punkte;

    // --- 3. Neue Kachel ------------------------------------
    // Nach einem wirksamen Zug ist garantiert ein Feld frei (es wurde
    // geschoben oder verschmolzen), also ist neu nie null.
    const neu = zufaelligeNeueKachel(brett);
    brett[neu.z][neu.s] = neu.wert;
    kacheln[neu.z][neu.s] = kachelErzeugen(neu.z, neu.s, neu.wert, true);

    // --- 4. HUD + Speichern --------------------------------
    if (zug.punkte > 0) zahlHochzaehlen(punkteElement, punkte);

    // --- 5. Spielende / 2048? ------------------------------
    if (!zugMoeglich(brett)) {
      spielBeenden();
    } else if (!hinweisGezeigt && hoechsteKachel(brett) >= 2048) {
      hinweisGezeigt = true; // nur einmalig
      phase = "hinweis"; // sperrt Eingaben, bis der Nutzer wählt
      verzoegert(overlayZeigen, animationsZeit(SCHIEBE_MS + 350));
    }
    // Erst jetzt speichern: hinweisGezeigt ist aktuell.
    // (Bei Spielende wird der Stand in spielBeenden() gelöscht.)
    if (phase !== "vorbei") spielstandSichern();
  }

  function overlayZeigen() {
    overlay.classList.add("sichtbar");
    ansagen("2048 erreicht! Weiterspielen oder neues Spiel?");
    document.getElementById("weiter").focus({ preventScroll: true });
  }

  function weiterspielen() {
    overlay.classList.remove("sichtbar");
    phase = "spielt";
    // Fokus vom (jetzt unsichtbaren) Knopf nehmen, sonst "hängt" er dort
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  function spielBeenden() {
    phase = "vorbei";
    entferne(SPIEL, "spielstand"); // ein beendetes Spiel soll nicht fortgesetzt werden
    ansagen(`Spiel vorbei mit ${punkte} Punkten.`);

    // Kurz warten, damit man das volle Brett noch sieht
    verzoegert(() => {
      const dialog = gameOverDialog({
        spiel: SPIEL,
        punkte,
        punkteText: `${punkte} Punkte`,
        richtung: "hoch",
        neustart: neuesSpiel,
      });
      // Egal wie der Dialog endet (Nochmal, Esc): Topliste + "Bester" neu anzeigen,
      // denn evtl. wurde gerade ein Eintrag gespeichert.
      dialog.addEventListener("close", seiteAktualisieren);
    }, animationsZeit(700));
  }

  // ---------------------------------------------------------
  // Eingabe: Tastatur
  // ---------------------------------------------------------
  const TASTEN = {
    arrowleft: "links",
    a: "links",
    arrowright: "rechts",
    d: "rechts",
    arrowup: "hoch",
    w: "hoch",
    arrowdown: "runter",
    s: "runter",
  };

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // Browser-Kürzel nicht stören
    if (document.querySelector("dialog[open]")) return; // Game-Over-Dialog offen → Tasten gehören ihm
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    if (phase === "hinweis" && e.key === "Escape") {
      // Esc im Overlay = Weiterspielen
      weiterspielen();
      return;
    }
    const richtung = TASTEN[e.key?.toLowerCase()];
    if (!richtung) return;
    e.preventDefault(); // Pfeiltasten sollen nicht die Seite scrollen
    zugAusfuehren(richtung);
  });

  // ---------------------------------------------------------
  // Eingabe: Wischen (Touch UND Maus) per Pointer Events
  // Pointer Events vereinen Maus, Finger und Stift in einer API.
  // Wir merken uns, wo der Zeiger aufsetzt, und vergleichen beim
  // Loslassen: Ist die größere Achse horizontal → links/rechts,
  // sonst hoch/runter. (spiel.css: touch-action:none verhindert, dass
  // der Browser die Geste fürs Scrollen "klaut".)
  // ---------------------------------------------------------
  let wischId = null;
  let wischStartX = 0;
  let wischStartY = 0;

  brettElement.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return; // nur linke Maustaste
    wischId = e.pointerId;
    wischStartX = e.clientX;
    wischStartY = e.clientY;
    try {
      brettElement.setPointerCapture(e.pointerId);
    } catch {
      /* nicht kritisch */
    }
  });

  brettElement.addEventListener("pointerup", (e) => {
    if (e.pointerId !== wischId) return;
    wischId = null;
    const dx = e.clientX - wischStartX;
    const dy = e.clientY - wischStartY;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < WISCH_MINDESTWEG) return; // nur ein Tippen
    if (Math.abs(dx) > Math.abs(dy)) {
      zugAusfuehren(dx > 0 ? "rechts" : "links");
    } else {
      zugAusfuehren(dy > 0 ? "runter" : "hoch");
    }
  });

  brettElement.addEventListener("pointercancel", () => {
    wischId = null;
  });

  // ---------------------------------------------------------
  // Knöpfe
  // ---------------------------------------------------------
  document.getElementById("neu").addEventListener("click", neuesSpiel);
  document.getElementById("weiter").addEventListener("click", weiterspielen);
  document.getElementById("overlay-neu").addEventListener("click", neuesSpiel);

  document.getElementById("reset").addEventListener("click", () => {
    spielZuruecksetzen(SPIEL); // löscht Topliste UND Spielstand
    neuesSpiel(); // laufendes Spiel gehört zum Spielstand → frisch starten
    seiteAktualisieren(); // leere Topliste + "Bester" 0 anzeigen
  });

  // ---------------------------------------------------------
  // Start: gespeichertes Spiel fortsetzen, sonst neu beginnen
  // ---------------------------------------------------------
  const gespeichert = spielstandLesen();
  if (gespeichert) {
    spielstandFortsetzen(gespeichert);
  } else {
    neuesSpiel();
  }
}

// Nur im Browser starten. In Node (Tests) gibt es kein "document" –
// dort werden nur die reinen Funktionen oben importiert.
if (typeof document !== "undefined") {
  starteSpiel();
}
