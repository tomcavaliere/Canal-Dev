// Configuration du projet Firebase.
// Console Firebase → Paramètres du projet → Vos applications → App Web → "Configuration du SDK".
// Ces valeurs sont publiques par conception : la sécurité repose sur firestore.rules
// et database.rules.json.
export const firebaseConfig = {
  apiKey: "AIzaSyBbNsC9L4zRaxJ3BrPoyAX2wv0TavsJH-Y",
  authDomain: "canal-dev-c18d7.firebaseapp.com",
  projectId: "canal-dev-c18d7",
  // Realtime Database (région UE, europe-west1) : sert uniquement à la présence « en ligne ».
  databaseURL: "https://canal-dev-c18d7-default-rtdb.europe-west1.firebasedatabase.app",
  storageBucket: "canal-dev-c18d7.firebasestorage.app",
  messagingSenderId: "259632246117",
  appId: "1:259632246117:web:f6e6ee3482e7cdc4d1858c",
};

// UID Firebase de l'administrateur (le seul qui peut créer des conversations
// et donner/retirer des accès). Doit être identique à ADMIN_UID dans firestore.rules.
// Pour le trouver : connecte-toi une fois, il s'affiche sur l'écran "Accès en attente".
export const ADMIN_UID = "WcAMpEXuhYbQjgeUnIsyMxJsO5f1";

// Clé publique VAPID des notifications push (publique par conception, comme la config ci-dessus).
// Identique à VAPID_PUBLIC_KEY dans functions/index.js ; la clé privée est un secret de la
// Cloud Function (voir README). Vide : notifications seulement tant que l'application est ouverte.
export const VAPID_PUBLIC_KEY = "BGIfDsUMg9u-DlSvdSZZw_X9j586Bf45DJdojiN4a6Z4KBux9iyvPhHOXkQBm4cep8uFBlKBGheZWVJ9UM-OixU";
