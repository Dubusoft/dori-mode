// Hermetic test env: drop ambient dori-lane / herdr host variables so tests never
// inherit the identity, permissions, or live herdr pane of the lane running them.
// Tests that need these vars set them explicitly themselves.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("HERDR_") || key.startsWith("DORI_")) delete process.env[key];
}
