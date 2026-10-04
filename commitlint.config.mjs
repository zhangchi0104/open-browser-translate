export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Subjects read as sentences here ("feat: Translate tables"), and bodies wrap freely.
    "subject-case": [0],
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
};
