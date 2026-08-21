import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// OBS: der ligger ogsaa en vite.config.js i src/. Den bliver ALDRIG laest — Vite
// kigger kun i projektroden. Flyt den ikke herop uden at tage indholdet nedenfor med,
// ellers forsvinder service workeren uden at nogen opdager det.
//
// Der er med vilje ingen react()-plugin her. Appen bygger i dag helt uden config, fordi
// Vite 8 selv oversaetter JSX. At tilfoeje pluginnet nu ville aendre oversaettelsen paa
// en dag hvor vi i forvejen aendrer meget — det kan tages separat.
export default defineConfig({
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

      workbox: {
        // Kun appens egne filer. Alt fra Supabase holdes udenfor: opgavedata haandteres
        // i appen med sin egen kopi, og adgangsoplysninger maa ALDRIG ligge i en cache.
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api/, /supabase/],
        // Gamle versioners filer ryddes, saa telefonen ikke fyldes op over tid.
        cleanupOutdatedCaches: true,

        // Tag over med det samme foerste gang. Uden den installerer service workeren
        // ved foerste besoeg men styrer foerst siden ved NAESTE aabning — og en
        // medarbejder der installerer appen og straks koerer ud i et hul ville staa
        // med en blank skaerm alligevel.
        //
        // Kombineret med skipWaiting: false, som er standard. Det er den kombination
        // der er forsvarlig: en NY version venter stadig til appen lukkes, saa den
        // aldrig overtager midt i en tidsregistrering.
        clientsClaim: true,
        skipWaiting: false,
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
