/* Taildrop install instruction (issue #93): the wizard used to show one prose
   sentence with the command inline ("…inbox: run sh ~/Downloads/x.sh"), and
   users typed the prose verb into their shell. These helpers keep the two
   apart: the command is exactly what runs (copyable on its own), the label
   is human prose that never embeds it. */

/** Exactly the runnable line — two words, pasteable as-is. Nothing else. */
export function dropRunCommand(fileName: string): string {
  return `sh ~/Downloads/${fileName}`;
}

/** The human sentence shown beside the command chip. Never contains the
    command text and never opens with an imperative that could read as part
    of it. */
export function dropInstructionLabel(fileName: string): string {
  void fileName; // the label points at the inbox, not the file's exact name
  return "Taildrop put the installer in the device's inbox (~/Downloads). On that device, in a terminal:";
}
