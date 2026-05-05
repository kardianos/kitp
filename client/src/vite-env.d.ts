/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_KITP_API_BASE?: string;
  readonly VITE_KITP_OIDC_ISSUER?: string;
  readonly VITE_KITP_OIDC_CLIENT_ID?: string;
  readonly VITE_KITP_OIDC_REDIRECT_URI?: string;
  readonly VITE_KITP_OIDC_SCOPES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
