import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// OBS: der ligger ogsaa en vite.config.js i src/. Den bliver ALDRIG laest — Vite
// kigger kun i projektroden. Flyt den ikke herop uden at tage indholdet nedenfor med,
// ellers forsvinder service workeren uden at nogen opdager det.
//
// Der er med vilje ingen react()-plugin her. Appen bygger i dag helt uden config, fordi
// Vite 8 selv oversaetter JSX. At tilfoeje pluginnet nu ville aendre oversaettelsen paa
// en dag hvor vi i forvejen aendrer meget — det kan tages separat.
// Tidspunktet for buildet bages ind, saa appen kan vise HVILKEN udgave der koerer.
// Med en service worker imellem er det ikke laengere til at se udefra om en rettelse
// er naaet frem — og saa bruger man en time paa at teste gammel kode.
const BYGGET = new Date().toISOString().slice(0, 16).replace("T", " ");

export default defineConfig({
  define: { __BYGGET__: JSON.stringify(BYGGET) },
  plugins: [
    VitePWA({
      // "prompt" og ikke "autoUpdate". En app der opdaterer sig selv midt i en
      // tidsregistrering kan smide det indtastede paa gulvet. Medarbejderen faar i
      // stedet en besked og bestemmer selv hvornaar.
      registerType: "prompt",

      // Manifestet ligger allerede i public/ og er i brug. Pluginnet maa ikke lave sit
      // eget, saa ville der vaere to der modsagde hinanden.
      manifest: false,
      injectRegister: null,

      // injectManifest og ikke generateSW.
      //
      // Foer skrev pluginnet hele service workeren selv ud fra opsaetningen herunder.
      // Den vej kan man ikke tage imod push-beskeder ad: filen laves fra bunden ved
      // hvert build, og der er ingen steder at laegge en push-haandtering ind.
      //
      // Nu ligger den i src/sw.js som almindelig kode vi selv ejer. ALT hvad der stod
      // i workbox-blokken foer, staar nu derinde — clientsClaim, oprydning i gamle
      // caches, og at nye versioner venter til appen lukkes. Laes kommentarerne i
      // filen foer du roerer den.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.js",

      injectManifest: {
        // Kun appens egne filer. Alt fra Supabase holdes udenfor: opgavedata haandteres
        // i appen med sin egen kopi, og adgangsoplysninger maa ALDRIG ligge i en cache.
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
        // Billeder fra kunderne kan vaere store. Uden loftet ville et enkelt stort
        // aktiv kunne sprænge precache-budgettet og faa hele registreringen til at fejle.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },

      // Service workeren maa ikke koere i udviklingstilstand. Ellers serverer den en
      // gammel kopi mens man sidder og retter, og man jagter fejl der ikke findes.
      devOptions: { enabled: false },
    }),
  ],
});
