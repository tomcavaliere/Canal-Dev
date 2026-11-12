// Configuration du projet Firebase.
// Console Firebase → Paramètres du projet → Vos applications → App Web → "Configuration du SDK".
// Ces valeurs sont publiques par conception : la sécurité repose sur firestore.rules.
export const firebaseConfig = {
  apiKey: "AIzaSyBbNsC9L4zRaxJ3BrPoyAX2wv0TavsJH-Y",
  authDomain: "canal-dev-c18d7.firebaseapp.com",
  projectId: "canal-dev-c18d7",
  storageBucket: "canal-dev-c18d7.firebasestorage.app",
  messagingSenderId: "259632246117",
  appId: "1:259632246117:web:f6e6ee3482e7cdc4d1858c",
};

// UID Firebase de l'administrateur (le seul qui peut créer des conversations
// et donner/retirer des accès). Doit être identique à ADMIN_UID dans firestore.rules.
// Pour le trouver : connecte-toi une fois, il s'affiche sur l'écran "Accès en attente".
export const ADMIN_UID = "WcAMpEXuhYbQjgeUnIsyMxJsO5f1";
