/** A secret's name in the store and in config `secrets`: an env variable name, upper case, at most 64 characters. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
