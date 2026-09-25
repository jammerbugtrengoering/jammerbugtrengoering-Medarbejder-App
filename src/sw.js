// Appens service worker.
//
// Den var FOER genereret af vite-plugin-pwa ud fra en workbox-opsaetning i
// vite.config.js. Den vej kan man ikke tage imod push-beskeder ad, fordi filen
// laves fra bunden ved hvert build og ikke kan udvides. Derfor er den skrevet
// haandholdt nu — men opfoerslen offline er den SAMME som foer, linje for linje.
// Aendrer du noget herinde, saa laes kommentarerne foerst: hver enkelt indstilling
// har kostet os noget at finde ud af.

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { clientsClaim } from "workbox-core";

// Listen over appens egne filer skrives ind her ved build. Den skal staa praecis
// saadan, ellers kan pluginnet ikke finde stedet.
precacheAndRoute(self.__WB_MANIFEST);

// Gamle versioners filer ryddes, saa telefonen ikke fyldes op over tid.
cleanupOutdatedCaches();

// Tag over med det samme foerste gang. Uden den installerer service workeren ved
// foerste besoeg men styrer foerst siden ved NAESTE aabning — og en medarbejder der
// installerer appen og straks koerer ud i et hul ville staa med en blank skaerm.
clientsClaim();

// Bemaerk at der IKKE staar skipWaiting() her. Det er med vilje, og det er den
// kombination der er forsvarlig: en NY version venter til appen lukkes, saa den
// aldrig overtager midt i en tidsregistrering. Appen spoerger medarbejderen selv,
// og foerst naar hun siger ja, sendes beskeden nedenfor.
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

// Alle sider serveres fra index.html. Supabase og api holdes udenfor: opgavedata
// haandteres i appen med sin egen kopi, og adgangsoplysninger maa ALDRIG i en cache.
//
// proev.html staar ogsaa udenfor. Den er oevelsesudgaven — en selvstaendig side,
// der ikke har noget med appen at goere. Uden den her linje ville en telefon med
// appen installeret svare med selve Worklist, naar nogen aabnede linket, og det
// ville ligne at linket var i stykker. Filen bliver stadig gemt paa telefonen
// som appens oevrige filer, saa oevelsen ogsaa kan tages uden daekning.
registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html"), {
  denylist: [/^\/api/, /supabase/, /^\/proev\.html$/],
}));

// ── Push ────────────────────────────────────────────────────────────────────
//
// Beskeden er krypteret hele vejen fra vores server til telefonen. Hverken Apple
// eller Google kan laese hvad der staar — kun den her kode kan pakke den ud.
self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    // Kommer der noget vi ikke forstaar, vises en tom besked hellere end ingen.
    // En medarbejder der ser "Worklist" og aabner appen, er bedre stillet end en
    // der intet fik at vide.
    d = {};
  }

  const titel = d.titel || "Worklist";
  const indhold = {
    body: d.tekst || "",
    icon: "/app-icon.png",
    badge: "/app-icon.png",
    // Samme maerke overskriver en tidligere besked af samme slags i stedet for at
    // lave en ny. Uden det ville fem planaendringer give fem notifikationer.
    tag: d.maerke || "besked",
    // Vibration OG lyd. Telefonen ligger i en lomme eller i en vogn, og en lydloes
    // notifikation er det samme som ingen notifikation.
    renotify: true,
    requireInteraction: false,
    data: { url: d.url || "/" },
  };

  // waitUntil er ikke til pynt. Uden den kan systemet lukke service workeren ned,
  // foer beskeden er vist, og saa forsvinder den sporloest.
  e.waitUntil(self.registration.showNotification(titel, indhold));
});

// Et tryk paa beskeden skal aabne DET STED beskeden handler om — ikke bare appen.
// Er appen allerede aaben, genbruges det vindue i stedet for at lave et nyt.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const maal = (e.notification.data && e.notification.data.url) || "/";

  e.waitUntil((async () => {
    // Beskeder til planlaeggerne peger paa planlaegningsappen (et andet domaene).
    // De maa ikke flytte Worklist-vinduet derhen — saa aabnes et nyt vindue.
    let fremmed = false;
    try { fremmed = new URL(maal, self.location.origin).origin !== self.location.origin; } catch { /* relativ */ }
    if (fremmed && self.clients.openWindow) return self.clients.openWindow(maal);
    const vinduer = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const v of vinduer) {
      if ("focus" in v) {
        // navigate kan fejle hvis vinduet ligger paa et fremmed domaene. Saa er
        // det bedre at faa appen frem uden at flytte den end at gaa i staa.
        try { await v.navigate(maal); } catch { /* fokus alene maa raekke */ }
        return v.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(maal);
  })());
});

// Telefonen kan selv forny et abonnement, typisk naar en noegle udloeber. Sker det
// uden at vi opdager det, holder beskederne bare op med at komme — uden fejl noget
// sted. Appen henter det nye abonnement ind ved naeste aabning; her sikrer vi blot,
// at det gamle ikke bliver staaende og se levende ud.
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil((async () => {
    const vinduer = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    vinduer.forEach((v) => v.postMessage({ type: "PUSH_FORNY" }));
  })());
});
