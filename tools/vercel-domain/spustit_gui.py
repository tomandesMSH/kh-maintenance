#!/usr/bin/env python3
"""Spustí okno přepínače domény na jedno kliknutí (= node vercel-domain.mjs gui).

Na Windows stačí na soubor dvakrát kliknout. Okno se otevře v prohlížeči;
ukončíš ho tlačítkem „Ukončit“ v okně nebo zavřením tohohle terminálu.
"""

import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "vercel-domain.mjs"


def pause_on_error(message: str) -> None:
    print(message)
    # Při dvojkliku by se terminál hned zavřel a hláška by zmizela.
    try:
        input("\nStiskni Enter pro zavření…")
    except EOFError:
        pass


def main() -> int:
    # Starší konzole bez UTF-8: radši otazník než pád na znaku ✗.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except AttributeError:
            pass
    node = shutil.which("node")
    if not node:
        pause_on_error("✗ Nenašel jsem Node.js. Nainstaluj ho z https://nodejs.org (verze 18 nebo novější).")
        return 1
    if not SCRIPT.exists():
        pause_on_error(f"✗ Chybí {SCRIPT.name} – spusť mě ze složky tools/vercel-domain.")
        return 1

    try:
        code = subprocess.call([node, str(SCRIPT), "gui"], cwd=HERE)
    except KeyboardInterrupt:
        return 0
    if code != 0:
        pause_on_error(f"\n✗ Přepínač skončil s chybou (kód {code}). Podívej se na hlášku výš.")
    return code


if __name__ == "__main__":
    sys.exit(main())
