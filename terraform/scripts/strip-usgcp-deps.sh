#!/bin/sh
# Strip @usgcp/* deps from a package.json so npm install doesn't fail
# on unresolved file: paths.
node -e '
  const fs = require("fs");
  const orig = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const thirdParty = {};
  for (const [k, v] of Object.entries(orig.dependencies || {})) {
    if (!k.startsWith("@usgcp/")) thirdParty[k] = v;
  }
  fs.writeFileSync("package.json", JSON.stringify({
    name: orig.name,
    version: orig.version,
    private: true,
    type: "module",
    main: "./dist/index.js",
    scripts: { start: "node ./dist/index.js" },
    dependencies: thirdParty,
  }, null, 2));
'
