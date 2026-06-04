// ============================================================
//  STEP 1: Replace these values with YOUR Firebase project config
//  Go to: Firebase Console → Project Settings → Your Apps → Config
// ============================================================
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// ============================================================
//  STEP 2: In Firebase Console → Authentication → Sign-in method
//  Enable: Email/Password
// ============================================================

// ============================================================
//  STEP 3: In Firebase Console → Firestore Database
//  Create database in production mode, then paste these rules:
//
//  rules_version = '2';
//  service cloud.firestore {
//    match /databases/{database}/documents {
//      match /{document=**} {
//        allow read, write: if request.auth != null;
//      }
//    }
//  }
// ============================================================

// ============================================================
//  STEP 4: Create first Admin user
//  Go to Firebase Console → Authentication → Add user
//  Email: admin@yourcompany.com  Password: choose one
//  Then in Firestore → users collection → add document:
//  id: (the UID from Auth), fields: name, email, role = "admin"
// ============================================================
