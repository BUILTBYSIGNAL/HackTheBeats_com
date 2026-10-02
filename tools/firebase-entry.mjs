// Entry point for the vendored Firebase bundle (vendor/firebase.bundle.js): only what the
// accounts feature uses. Firestore "lite" talks plain REST, which is all we need and a
// fraction of the size of the full client.
export { initializeApp } from 'firebase/app';
export {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithCredential,
  getAdditionalUserInfo,
  signOut,
  onAuthStateChanged,
  connectAuthEmulator,
} from 'firebase/auth';
export {
  getFirestore,
  connectFirestoreEmulator,
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  writeBatch,
} from 'firebase/firestore/lite';
