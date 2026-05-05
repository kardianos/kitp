// Environment configuration sourced from Vite's import.meta.env.
//
// All variables are surfaced via VITE_KITP_* so they are inlined at build time.
// Defaults keep the app usable in local dev without any env file.

const env = import.meta.env;

export const KITP_API_BASE: string = env.VITE_KITP_API_BASE ?? '';

export const KITP_OIDC_ISSUER: string = env.VITE_KITP_OIDC_ISSUER ?? '';
export const KITP_OIDC_CLIENT_ID: string = env.VITE_KITP_OIDC_CLIENT_ID ?? '';
export const KITP_OIDC_REDIRECT_URI: string = env.VITE_KITP_OIDC_REDIRECT_URI ?? '';
export const KITP_OIDC_SCOPES: string =
  env.VITE_KITP_OIDC_SCOPES ?? 'openid profile email';

export const OIDC_ENABLED: boolean =
  KITP_OIDC_ISSUER !== '' && KITP_OIDC_CLIENT_ID !== '' && KITP_OIDC_REDIRECT_URI !== '';
