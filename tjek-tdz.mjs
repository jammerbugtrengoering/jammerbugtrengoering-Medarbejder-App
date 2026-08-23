// Fanger den ene fejltype der har gjort appen blank i produktion tre gange:
// en variabel der bruges før den er erklæret.
//
// oxlint har en regel der hedder no-use-before-define, men den gør ingenting —
// afprøvet på en minimal fejl, både som warning og med --deny. TypeScript fanger den
// derimod som TS2448, også i almindelig JavaScript.
//
// Vi typetjekker IKKE resten. En 9.000 linjers utypet fil giver hundredvis af andre
// fejl der ikke betyder noget her, så der filtreres hårdt: kun TS2448 (brugt før
// erklæring) og TS2454 (brugt før tildeling) får lov at stoppe et build.
import { execFileSync } from "node:child_process";

const FARLIGE = ["TS2448", "TS2454"];

let output = "";
try {
  execFileSync("npx", [
    "tsc", "--noEmit", "--allowJs", "--checkJs",
    "--jsx", "preserve", "--target", "es2022",
    "--module", "esnext", "--moduleResolution", "bundler",
    "--skipLibCheck", "src/App.jsx",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  // tsc afslutter med fejlkode fordi der er masser af andre fejl. Det er forventet.
  output = (e.stdout || "") + (e.stderr || "");
}

const fund = output.split("\n").filter((l) => FARLIGE.some((k) => l.includes(k)));

if (fund.length > 0) {
  console.error("\n\x1b[31mBrugt før erklæring — det gør appen blank i produktion:\x1b[0m\n");
  fund.forEach((l) => console.error("  " + l));
  console.error("\nFlyt erklæringen op over brugen, og byg igen.\n");
  process.exit(1);
}

console.log("Ingen variabler brugt før erklæring.");
