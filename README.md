# TexFab ERP — Setup Guide

## Files in this folder
```
texfab/
├── index.html          ← Login page
├── dashboard.html      ← Main dashboard (all modules)
├── style.css           ← Full dark theme styles
├── app.js              ← All Firebase logic (CRUD, real-time)
├── firebase-config.js  ← YOUR Firebase config goes here
└── README.md           ← This file
```

---

## Step 1 — Create Firebase Project

1. Go to https://console.firebase.google.com
2. Click **Add Project** → name it (e.g. `texfab-erp`)
3. Disable Google Analytics (optional) → Create Project

---

## Step 2 — Enable Authentication

1. In Firebase Console → **Authentication** → Get Started
2. Click **Sign-in method** tab
3. Enable **Email/Password** → Save

---

## Step 3 — Create Firestore Database

1. In Firebase Console → **Firestore Database** → Create Database
2. Choose **Start in production mode** → Select your region → Done
3. Go to **Rules** tab and paste:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```
4. Click **Publish**

---

## Step 4 — Get Your Config

1. In Firebase Console → ⚙️ **Project Settings** (gear icon)
2. Scroll to **Your apps** → Click **</>** (Web app) → Register app
3. Copy the `firebaseConfig` object
4. Open `firebase-config.js` and replace the placeholder values

---

## Step 5 — Create Your First Admin User

1. Firebase Console → **Authentication** → **Users** → **Add User**
2. Enter email + password → Copy the **UID** shown

3. Firebase Console → **Firestore Database** → **Start Collection**
   - Collection ID: `users`
   - Document ID: paste the UID from step 2
   - Add fields:
     - `name` (string): `Admin User`
     - `email` (string): your email
     - `role` (string): `admin`

---

## Step 6 — Deploy to GitHub Pages

1. Create a GitHub repo (e.g. `texfab-erp`)
2. Upload all files from this folder
3. Go to repo **Settings** → **Pages** → Source: `main` branch → `/root`
4. Your app will be live at: `https://yourusername.github.io/texfab-erp/`

---

## How Real-Time Works

- Every user sees the same data — Firestore listeners push updates instantly
- When User A saves a GRN, User B sees the stock update in seconds
- No page refresh needed — `onSnapshot` keeps all views live

---

## Collections in Firestore

| Collection          | Used For                        |
|---------------------|---------------------------------|
| `users`             | Login profiles + roles          |
| `materials`         | Material master with stock      |
| `suppliers`         | Supplier master                 |
| `processors`        | Dyeing & lamination houses      |
| `job_workers`       | Job worker master               |
| `customers`         | Customer master                 |
| `purchase_orders`   | POs + GRN tracking              |
| `stock`             | Full stock ledger (every move)  |
| `transfers`         | Material transfer challans      |
| `dyeing_orders`     | Dyeing order tracking           |
| `lamination_orders` | Lamination order tracking       |
| `job_work`          | Job work issues + receipts      |
| `transactions`      | Audit log of all actions        |
| `counters`          | Auto-incrementing order numbers |

---

## User Roles

| Role        | Access                                        |
|-------------|-----------------------------------------------|
| `admin`     | Everything                                    |
| `store`     | Stock, Transfer, GRN                          |
| `purchase`  | Purchase, Suppliers, Stock                    |
| `production`| Stock, Transfer, Dyeing, Lamination, Job Work |
| `dyeing`    | Dyeing Orders, Transfer                       |
| `lamination`| Lamination Orders, Transfer                   |
| `accounts`  | Reports, Purchase, Stock (read)               |
| `jobcoord`  | Job Work, Transfer                            |

---

## Adding More Users

1. Firebase Console → Authentication → Add User (email + password)
2. Copy their UID
3. Firestore → `users` collection → Add document with their UID as ID
4. Add: `name`, `email`, `role` fields

---

## Local Testing

Just open `index.html` in a browser — no server needed since Firebase SDK loads from CDN.
If you see CORS errors, use VS Code's **Live Server** extension.
