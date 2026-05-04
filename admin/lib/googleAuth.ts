type GoogleCredentialResponse = {
  credential: string;
};

type GooglePromptNotification = {
  isNotDisplayed: () => boolean;
  isSkippedMoment: () => boolean;
  getDismissedReason: () => string;
};

type GoogleAccountsId = {
  initialize: (config: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
  }) => void;
  prompt: (momentListener?: (notification: GooglePromptNotification) => void) => void;
};

type GoogleWindow = Window & {
  google?: {
    accounts: {
      id: GoogleAccountsId;
    };
  };
};

const GIS_SRC = "https://accounts.google.com/gsi/client";
let gisLoadPromise: Promise<void> | null = null;

function getGoogleWindow(): GoogleWindow {
  return window as GoogleWindow;
}

function loadGoogleGIS(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Google GIS solo puede cargarse en el navegador"));
  }

  if (gisLoadPromise) return gisLoadPromise;

  gisLoadPromise = new Promise<void>((resolve, reject) => {
    const w = getGoogleWindow();
    if (w.google?.accounts?.id) {
      resolve();
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("No se pudo cargar Google Identity Services")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("No se pudo cargar Google Identity Services"));
    document.head.appendChild(script);
  });

  return gisLoadPromise;
}

export function getGoogleCredential(clientId: string): Promise<string> {
  const executePromise = async () => {
    try {
      await loadGoogleGIS();
      const w = getGoogleWindow();
      if (!w.google?.accounts?.id) {
        throw new Error("Google Identity Services no está disponible");
      }

      return new Promise<string>((resolve, reject) => {
        w.google!.accounts.id.initialize({
          client_id: clientId,
          callback: (response: GoogleCredentialResponse) => {
            if (response.credential) {
              resolve(response.credential);
            } else {
              reject(new Error("No se recibió credencial de Google"));
            }
          },
          auto_select: false,
          cancel_on_tap_outside: true,
        });

        w.google!.accounts.id.prompt((notification: GooglePromptNotification) => {
          if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
            reject(new Error("Ventana de Google cerrada o bloqueada. Intenta nuevamente."));
          }
        });
      });
    } catch (err) {
      throw err;
    }
  };

  return executePromise();
}
