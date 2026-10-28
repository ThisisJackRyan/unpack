// On-screen text waiting for copy approval. Each string here is a
// candidate: it ships only once approved (see the PR's strings file), and
// then moves next to the code that shows it.

// PENDING COPY APPROVAL #1: the new reading forms (/learn/new, and a
// teacher's new reading), in the form's error box, when the request to
// create the reading got no answer (the connection dropped, a 504, a
// sign-in that lapsed): the reading may or may not have been saved.
export const CREATE_NO_REPLY_MESSAGE =
  "We couldn’t hear back, so the reading may have been saved. What you entered is still here. Check your readings before you try again.";
