module.exports = {
  testEnvironment: "node",
  testMatch: ["**/*.test.js"],
  testPathIgnorePatterns: ["/node_modules/"],
  collectCoverageFrom: [
    "src/**/*.js",
    "!src/**/*.test.js",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov", "html"],
  verbose: true,
  forceExit: true,
  testTimeout: 10000,
};
