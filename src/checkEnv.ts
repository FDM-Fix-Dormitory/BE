function checkEnv(env: NodeJS.ProcessEnv) {
  if (!env.PORT) return false;
  if (!env.SESSION_SECRET) return false;
  return true;
}

export { checkEnv };
