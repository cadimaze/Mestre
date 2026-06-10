// ─────────────────────────────────────────────────────────────────────────────
// Configuração do Firebase — preencha com os dados do seu projeto
// Firebase Console → Configurações do projeto → Seus apps → SDK de configuração
// ─────────────────────────────────────────────────────────────────────────────
export const FIREBASE_CONFIG = {
  apiKey:            "SUA_API_KEY",
  authDomain:        "SEU_PROJETO.firebaseapp.com",
  projectId:         "SEU_PROJETO",
  storageBucket:     "SEU_PROJETO.firebasestorage.app",
  messagingSenderId: "SEU_SENDER_ID",
  appId:             "SEU_APP_ID",
};

// E-mail cadastrado como Mestre — apenas este e-mail recebe acesso total à campanha
export const MASTER_EMAIL = "seuemail@exemplo.com";

// ID da campanha no Firestore — não altere
export const CAMPAIGN_ID  = "mares-e-mares";
