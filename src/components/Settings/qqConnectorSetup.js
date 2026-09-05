// Keep startup and authentication ordered: a failed startup must not connect
// to an unrelated WebUI, and a 2FA challenge must remain visible to the user.
export async function startAndConnectNapcat(connector, { qq, managed }) {
  const launch = await connector.launchNapcat(qq || null);
  if (!managed) return { launch };
  try {
    const session = await connector.webuiLogin({
      baseUrl: 'http://127.0.0.1:6099',
      token: launch?.webuiToken || '', // Backend can recover its saved token.
      totpCode: null,
    });
    return { launch, session };
  } catch (error) {
    // The process is already running. Preserve its result and allow a manual
    // reconnect instead of reporting the entire startup as failed.
    return { launch, connectionError: error?.message || String(error) };
  }
}
