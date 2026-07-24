#!/bin/sh
# Strip @usgcp/* deps from a package.json so npm install doesn't fail
# on unresolved file: paths. Preserve all other manifest fields.
node -e '
  const fs = require("fs");
  const orig = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const stripUsGcp = (deps = {}) => Object.fromEntries(
    Object.entries(deps).filter(([k]) => !k.startsWith("@usgcp/"))
  );
  const next = {
    ...orig,
    dependencies: stripUsGcp(orig.dependencies),
  };
  if (orig.optionalDependencies) {
    next.optionalDependencies = stripUsGcp(orig.optionalDependencies);
  }
  if (orig.devDependencies) {
    next.devDependencies = stripUsGcp(orig.devDependencies);
  }
  if (orig.peerDependencies) {
    next.peerDependencies = stripUsGcp(orig.peerDependencies);
  }
  fs.writeFileSync("package.json", JSON.stringify(next, null, 2) + "\n");
'
