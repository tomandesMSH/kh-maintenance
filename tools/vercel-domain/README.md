# Přepínač domény: Muzio ↔ údržbová stránka

`vercel-domain.mjs` přesouvá vlastní doménu mezi Vercel projekty `keyboardheromuzio` (produkce) a
`kh-maintenance-six` (tahle údržbová stránka). Potřebuje jen Node 18+, žádné balíčky. Na web se
nenasazuje (`.vercelignore`), spouští se u tebe na počítači.

```bash
cd tools/vercel-domain
cp .env.example .env              # vyplň VERCEL_TOKEN a CUSTOM_DOMAIN (případně VERCEL_TEAM_ID)
node vercel-domain.mjs gui        # okno v prohlížeči: stav + tlačítka
node vercel-domain.mjs status     # kde doména běží, jestli je produkce pozastavená
node vercel-domain.mjs down       # na údržbu (alias: maintenance); --pause pozastaví i produkci
node vercel-domain.mjs up         # zpět na produkci (alias: live), pozastavenou nejdřív obnoví
```

- Je bezpečné ho pustit znovu: doménu, která na zdrojovém projektu chybí nebo už je na cílovém,
  přeskočí a přiřazení dokončí.
- Mezi odebráním a přidáním domény je výpadek pár vteřin – Vercel nedovolí mít jednu doménu na
  dvou projektech naráz.
- Okno (`gui`) běží jen na `127.0.0.1` s náhodným klíčem v adrese, takže doménu nepřepne žádná
  jiná stránka. Přepnutí chce dvě kliknutí.

**Token:** Vercel → Account Settings → Tokens → Create Token (scope: tým, kam projekty patří).
Patří jen do `.env`, ten je v `.gitignore`.
