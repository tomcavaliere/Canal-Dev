// L'application a déménagé de GitHub Pages vers Firebase Hosting : les anciens liens
// redirigent vers la nouvelle adresse (même chemin, sans paramètres).
if (location.hostname === "tomcavaliere.github.io") {
  const path = location.pathname.replace(/^\/Canal-Dev\/?/, "/");
  location.replace("https://canal-dev-c18d7.web.app" + path);
}
