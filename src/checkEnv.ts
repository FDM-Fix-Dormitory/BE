function checkEnv(env: NodeJS.ProcessEnv) {
  if (!env.PORT) return false;
  if (!env.SESSION_SECRET) return false;
  if (!env.DB_USER) return false;
  if (!env.DB_NAME) return false;
  return true;
}

export { checkEnv };
