// Social sign-in — web / default stub. Metro resolves this file for the web
// export (and TypeScript resolves it for the importer), while `socialAuth.native.ts`
// provides the real Apple/Google implementation on iOS/Android. Keeping the
// native-auth packages out of this file is what keeps `expo export --platform web`
// and the boot smoke clean: on web both providers are simply unavailable, so no
// social buttons render.
export const appleAvailable = false;
export const googleAvailable = false;

export async function signInWithApple(): Promise<void> {
  throw new Error('Apple sign-in is unavailable on web');
}

export async function signInWithGoogle(): Promise<void> {
  throw new Error('Google sign-in is unavailable on web');
}
