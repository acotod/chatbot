type FacebookLoginStatus = "connected" | "not_authorized" | "unknown";

type FacebookAuthResponse = {
  accessToken: string;
};

type FacebookLoginResponse = {
  status: FacebookLoginStatus;
  authResponse?: FacebookAuthResponse;
};

type FacebookLoginOptions = {
  scope: string;
};

type FacebookSDK = {
  init: (config: {
    appId: string;
    cookie: boolean;
    xfbml: boolean;
    version: string;
  }) => void;
  login: (callback: (response: FacebookLoginResponse) => void, options: FacebookLoginOptions) => void;
};

type FacebookWindow = Window & {
  FB?: FacebookSDK;
  fbAsyncInit?: () => void;
};

const SDK_SRC = "https://connect.facebook.net/es_LA/sdk.js";

let sdkLoadPromise: Promise<void> | null = null;
let initializedAppId: string | null = null;

function getFacebookWindow(): FacebookWindow {
  return window as FacebookWindow;
}

function loadFacebookSdk(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Facebook SDK solo puede cargarse en el navegador"));
  }

  if (sdkLoadPromise) return sdkLoadPromise;

  sdkLoadPromise = new Promise<void>((resolve, reject) => {
    const w = getFacebookWindow();
    if (w.FB) {
      resolve();
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>('script[src="' + SDK_SRC + '"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("No se pudo cargar Facebook SDK")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = SDK_SRC;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("No se pudo cargar Facebook SDK"));
    document.head.appendChild(script);
  });

  return sdkLoadPromise;
}

function ensureFacebookInit(appId: string): void {
  const w = getFacebookWindow();
  if (!w.FB) throw new Error("Facebook SDK no esta disponible");

  if (initializedAppId === appId) return;

  w.FB.init({
    appId,
    cookie: true,
    xfbml: false,
    version: "v25.0",
  });

  initializedAppId = appId;
}

export async function getFacebookAccessToken(appId: string): Promise<string> {
  if (!appId) {
    throw new Error("Falta NEXT_PUBLIC_FACEBOOK_APP_ID en la UI");
  }

  await loadFacebookSdk();
  ensureFacebookInit(appId);

  const w = getFacebookWindow();
  if (!w.FB) throw new Error("Facebook SDK no disponible");

  const authToken = await new Promise<string>((resolve, reject) => {
    w.FB!.login(
      (response) => {
        if (response.status !== "connected" || !response.authResponse?.accessToken) {
          reject(new Error("No se pudo obtener el token de Facebook"));
          return;
        }
        resolve(response.authResponse.accessToken);
      },
      { scope: "email,public_profile" }
    );
  });

  return authToken;
}
