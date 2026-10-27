// Shared by the reading delete and cap raise actions and their buttons.
// Kept out of the actions file because a "use server" file may only
// export async functions.

export type DeleteReadingState = {
  // Nothing was deleted; the dialog stays open with this.
  error?: string;
};

export type RaiseCapState = {
  // What happened, for the live region.
  message?: string;
  // Nothing changed.
  error?: string;
};
