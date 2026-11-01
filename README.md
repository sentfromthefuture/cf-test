# DemandRadar - Autonomous Market Intelligence Platform

> **"Discover what the world needs before someone builds it."**
> A platform powered by autonomous research bots that monitor public online discussions, cluster real human problems, analyze market demand, and generate development-ready software business opportunities and PRDs.

---

## 🚀 Quick Start (Local Development)

### 1. Prerequisites
- **Node.js** (v18 or higher recommended)
- **Google Gemini API Key** (get one free at [Google AI Studio](https://aistudio.google.com/))

### 2. Installation
```bash
# Clone your repository
git clone https://github.com/YOUR_USERNAME/demandradar.git
cd demandradar

# Install dependencies
npm install

# Setup environment variables
cp .env.example .env
```

Edit `.env` and insert your Gemini API Key:
```env
GEMINI_API_KEY="AIzaSy..."
PORT=3000
```

### 3. Start Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 📦 How to Push to GitHub

Run these commands in your project folder:

```bash
# 1. Initialize git (if not already done)
git init

# 2. Add all files
git add .

# 3. Commit
git commit -m "Initial commit: DemandRadar autonomous market intelligence platform"

# 4. Set branch to main
git branch -M main

# 5. Connect to your GitHub repository
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPO_NAME.git

# 6. Push
git push -u origin main
```

---

## ☁️ Deployment Guide: Cloudflare & Scalability

You mentioned deploying to **Cloudflare** for authentication and scalability. Here is the recommended architecture:

### Option A: Cloudflare Pages + Full-Stack Container (Recommended for Best Scalability & Auth)

1. **Deploy the Node.js App** to a modern serverless container host like **Render**, **Railway**, **Fly.io**, or **Google Cloud Run**:
   - Connect your GitHub repo.
   - Set Build Command: `npm run build`
   - Set Start Command: `npm start`
   - Set Environment Variable: `GEMINI_API_KEY=your_key`
2. **Put Cloudflare in Front (Proxied DNS "Orange Cloud")**:
   - In Cloudflare DNS, add a `CNAME` pointing your domain (e.g. `demandradar.com`) to your server URL with **Proxy Status: Proxied**.
   - **Instant Benefits**:
     - Global edge CDN caching.
     - Enterprise DDoS protection.
     - SSL / TLS 1.3 encryption.
     - Global speed acceleration.
3. **Turn on Authentication via Cloudflare Zero Trust**:
   - In your Cloudflare Dashboard, go to **Zero Trust > Access > Applications**.
   - Add your domain `demandradar.com` (or specific paths like `/api/admin` or `/intelligence`).
   - Enable **One-Time Pin (Email OTP)**, **Google Auth**, or **GitHub OAuth**.
   - Cloudflare will authenticate users at the edge before requests even hit your server!

---

### Option B: Pure Cloudflare Pages + Pages Functions

If you want the entire app to run 100% natively on Cloudflare Pages without an external Node container:

1. In Cloudflare Dashboard, go to **Workers & Pages > Create application > Pages > Connect to Git**.
2. Select your `demandradar` GitHub repo.
3. Configure Build Settings:
   - **Framework preset**: `Vite`
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
4. Add Environment Variables in Cloudflare Pages Settings:
   - `GEMINI_API_KEY` = your Google Gemini API key.
5. Functions in the `/functions` directory are automatically deployed as Cloudflare Edge Workers to handle server-side API calls.

---

## 💳 Payment Gateway (PayPal & Binance Pay)

DemandRadar comes with a built-in payout configuration system:
- **PayPal**: Set your PayPal email or PayPal.Me handle in the in-app Merchant Settings (click the gear icon in the checkout window or footer).
- **Binance Pay / Crypto**: Set your Binance Pay ID and your USDT (TRC-20 / BEP-20) address. The app automatically renders the QR code and payment verification modal.
- Settings are saved and persist seamlessly.

---

## 📁 Project Structure

```
├── functions/             # Cloudflare Pages Functions (edge serverless API routes)
├── src/
│   ├── components/        # React UI components (Dashboard, Explorer, Dossier, etc.)
│   ├── data/              # Initial seed research & scoring algorithms
│   ├── types.ts           # TypeScript interfaces & definitions
│   ├── App.tsx            # Root application orchestrator
│   └── main.tsx           # React DOM root
├── server.ts              # Node.js Express server + Gemini AI endpoints
├── package.json           # Dependencies and scripts
├── vite.config.ts         # Vite bundler configuration
└── README.md              # Project documentation
```

---

## 📄 License
MIT License - Build, customize, and monetize freely.
