// Files Bun embeds as text (`import x from "./file.sh" with { type: "text" }`), so a compiled walkie carries them.
declare module "*.sh" {
  const text: string;
  export default text;
}
