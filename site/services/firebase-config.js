/*
 * Firebase Web configuration: paste values from Firebase Console → Project settings → Your apps.
 * The Web apiKey is a public identifier, not a server secret. Never add a service-account key here.
 */
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};

// Enable only while running `firebase emulators:start` locally.
export const useFirebaseEmulators = false;
