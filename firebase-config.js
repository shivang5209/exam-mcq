/**
 * QuizForge Firebase Configuration & Initialization
 * 
 * Replace the placeholder values in `firebaseConfig` with your actual 
 * credentials from the Firebase Console (https://console.firebase.google.com).
 */

const firebaseConfig = {
  apiKey: "AIzaSyD5Q_-aP2kG_lvzn-sHB65jVmhsOUQRZxc",
  authDomain: "quizforge-a0db9.firebaseapp.com",
  projectId: "quizforge-a0db9",
  storageBucket: "quizforge-a0db9.firebasestorage.app",
  messagingSenderId: "893411544428",
  appId: "1:893411544428:web:4ddf03fb6d585a96daf749",
  measurementId: "G-LDJ3M7Y3T9"
};

let isFirebaseInitialized = false;
let db = null;
let auth = null;

// Self-initialize if config is provided
try {
  if (
    typeof firebase !== 'undefined' &&
    firebaseConfig.apiKey && 
    firebaseConfig.apiKey !== "YOUR_API_KEY_HERE"
  ) {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    auth = firebase.auth();
    isFirebaseInitialized = true;
    console.log("Firebase initialized successfully!");
  } else {
    console.warn("Firebase config is empty or default. Online rooms features will be disabled until configured.");
  }
} catch (error) {
  console.error("Error initializing Firebase:", error);
}

// Make configuration accessible globally
window.FirebaseConfig = {
  isInitialized() {
    return isFirebaseInitialized;
  },
  getDb() {
    return db;
  },
  getAuth() {
    return auth;
  }
};
