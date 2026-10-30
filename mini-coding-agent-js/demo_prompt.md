"create hello.js that prints today's date and time, run it and save to current folder with a random number between 100 and 999 as hellloNNN.js where NNN is that random number printing out in console location of the file and use that for the saved output as hello-output-NNN.txt"  

"save a file test.txt that contains 'HELLO WORLD' and save to the desktop"   # expect FORBIDDEN: SAVE ... - the Desktop is outside the workspace

npm run demo

npm start -- "create hello.js that prints today's date and time, run it and save to current folder with a random number between 100 and 999 as hellloNNN.js where NNN is that random number printing out in console location of the file and use that for the saved output as hello-output-NNN.txt"   

Memory, the short version (see README "Long-term memory" and src/memory.js):

npm run demo                 # step 13 remembers one fact, step 14 recalls it
node src/cli.js --memory   # the store, and exactly what the system prompt gets
node src/cli.js --demo     # run it again: "memory <- memory.md - 1 memory added"

And a prompt that should end with a remember call, not just a file:

npm start -- "work out how this package is tested, run the tests, and remember the command and the Node version it needs so you do not have to rediscover them next time"