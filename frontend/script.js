const API_BASE_URL = 'http://localhost:3000/api/player/';
//server checks if a player exists 
//node js server

const STATS_API_URL = 'http://localhost:3000/api/stats/';
//sever gets "basic" season stats
//node js server

const PREDICT_API_URL = 'http://localhost:5001/api/ml/predict/';
//server makes machine learning prediction 
//this is the api that is on the python server in order to handle data manipulation a little easier

const COMPARE_API_URL = 'http://localhost:3000/api/compare/';
//compares two players 
//node js server

const NEXT_GAME_API_URL = 'http://localhost:3000/api/next-game/';
//finds the player/players next game/games
//node js server

//query parser
async function parseQuery(userQuery){
    //convert to lower case to make matching easier
    let query = userQuery.toLowerCase();

    //object just to track what information we have
    let result = {
        isComparison: false, //does the user want to compare two players
        statsAskedFor: [], //what stats are being asked for (points, rebounds, steals, blocks, turnovers, assists)
        playerName: '', //first player name
        player2Name: '',         //secondn player name, if it is a comparison
        opponentTeam: '', //who is the player playing against
        message: '' //summary message for debuggin purposes
    };

    //check for a comparison (look for key words like "vs" "compare", etc.)
    result.isComparison = checkIfComparison(query);

    //check for the requested statas
    result.statsAskedFor = findStatsInQuery(query);
    
    //find the names

    //if comparing, find two player names
    if (result.isComparison) {
        const players = await findTwoPlayersInQuery(userQuery);
        result.playerName = players.player1;
        result.player2Name = players.player2;
        //find opponent team if clarified by the user
        result.opponentTeam = await findOpponentInQuery(userQuery, '');
    } else {
        //if not comparing, find one player name
        result.playerName = await findPlayerNameInQuery(userQuery);
        //find the team if clarifed, but remove player name from the query to make the team look easier/quicker
        result.opponentTeam = await findOpponentInQuery(userQuery, result.playerName);
    }

    //create summary message for debugging

    //if comparison = true, and both players are found
    if (result.isComparison && result.playerName && result.player2Name){
        result.message = `Comparing ${result.playerName} vs ${result.player2Name}`;
    } else if (result.isComparison) {
        //if comparison is true, but not both players can be found
        result.message = "Comparison requested but couldn't find both players";
    } else if (result.playerName.length > 0){
        //single playe query
        result.message = "User wants stats for player: " + result.playerName;
        if (result.opponentTeam.length > 0) {
            result.message += " vs " + result.opponentTeam;
        }
        if (result.statsAskedFor.length > 0){
             result.message += " - Stats: " + result.statsAskedFor.join(", ");
        }
    }
    else if (result.statsAskedFor.length > 0){
        result.message = "User wants stats: " + result.statsAskedFor.join(", ");
    }
    else {
        result.message = "No specific stats requested";
    }
    return result;
}

//trying to split the query on comparison keywords
async function findTwoPlayersInQuery(userQuery) {
    const query = userQuery.toLowerCase();
    
    let parts = [];
    if (query.includes(' vs ')) {
        parts = userQuery.split(/ vs /i); ///i = case insensitive (ex: vs, VS, Vs)
    } else if (query.includes(' versus ')) {
        parts = userQuery.split(/ versus /i);
    } else if (query.includes(' or ')) {
        parts = userQuery.split(/ or /i);
    } else if (query.includes('compare ')) {
        const afterCompare = userQuery.substring(query.indexOf('compare ') + 8); //'compare' has a length of 8, so we must get the position after the full word
        parts = afterCompare.split(/ and | to /i);
    } else {
        return await findTwoPlayersByScanning(userQuery);
    }
    
    if (parts.length >= 2) {
        const player1 = await findPlayerNameInQuery(parts[0]); //search for player name in the first part
        const player2 = await findPlayerNameInQuery(parts[1]); //search for a player name in the second part
        return { player1, player2 }; //return object with both players
    }
    
    return { player1: '', player2: '' };
}

async function findTwoPlayersByScanning(userQuery) {
    const queryWords = userQuery.split(/\s+/); //splits on any whitespace 

    //array of common words to ignore
    const skipWords = ['how', 'many', 'will', 'have', 'get', 'score', 'what', 
                       'is', 'are', 'the', 'a', 'an', 'points', 'rebounds', 
                       'assists', 'stats', 'for', 'about', 'tell', 'me', 'against',
                       'vs', 'versus', 'playing', 'who', 'better', 'or', 'compare',
                       'between', 'and'];
    
    let foundPlayers = []; //empty array to store players 
    
    //loop through the words, but stop if 2 players found already, or length -1 (checking in pairs, looking for first and last name)
    for (let i = 0; i < queryWords.length - 1 && foundPlayers.length < 2; i++) {
        const word = queryWords[i].toLowerCase(); //get current word
        const nextWord = queryWords[i + 1].toLowerCase(); //get next word
        
        
        if (skipWords.includes(word) || skipWords.includes(nextWord)) continue; //if either word is in skipWords, skip to next iteration
        
        let playerName = await tryFindPlayer(queryWords[i] + ' ' + queryWords[i + 1]); //try the two words together as a name

        //if we found a player and haven't yet added them
        if (playerName && !foundPlayers.includes(playerName)) {
            foundPlayers.push(playerName); //add to foundPlayers array
            i++; //skip the next word (we already used it)
            continue;
        }
        
        playerName = await tryFindPlayer(queryWords[i + 1] + ' ' + queryWords[i]); //trying words in reverse order

        if (playerName && !foundPlayers.includes(playerName)) {
            foundPlayers.push(playerName);
            i++;
            continue;
        }
    }
    
    //if we haven't found 2 players yet, try searching withs single words
    if (foundPlayers.length < 2) {
        for (let i = 0; i < queryWords.length && foundPlayers.length < 2; i++) {
            const word = queryWords[i].toLowerCase();
            if (skipWords.includes(word)) continue;
            
            const playerName = await tryFindPlayer(queryWords[i]);
            if (playerName && !foundPlayers.includes(playerName)) {
                foundPlayers.push(playerName);
            }
        }
    }
    
    //return both players, or empty strings if not found
    return {
        player1: foundPlayers[0] || '',
        player2: foundPlayers[1] || ''
    };
}

//check for common words that signify a comparison is requested

function checkIfComparison(query){
    let comparisonWords = [
        'vs', 
        'versus', 
        ' or ', 
        'compare', 
        'better', 
        'who', 
        'which', 
        'between'
    ];

    //if a word is found, return true

    for (let i = 0; i < comparisonWords.length; i++){
        if (query.includes(comparisonWords[i])){
            return true;
        }
    }

    //if not match found, return false
    return false;
}

//look for stats keywords and returns an array of which stats are being requested

function findStatsInQuery(query){
    let foundStats = [];

    if (query.includes("points") || query.includes("pts") || query.includes("score")){
        foundStats.push("points");
    }

    if (query.includes("rebounds") || query.includes("rebs") || query.includes("boards")){
        foundStats.push("rebounds");
    }

    if (query.includes("assists") || query.includes("ast") || query.includes("dimes")) {
        foundStats.push("assists");
    }
    
    if (query.includes("steals") || query.includes("steal")) {
        foundStats.push("steals");
    }
    
    if (query.includes("blocks") || query.includes("block")) {
        foundStats.push("blocks");
    }
    
    if (query.includes("three") || query.includes("3pt") || query.includes("3-point")) {
        foundStats.push("three-pointers");
    }

    if (query.includes("turnover") || query.includes("turnovers")) {
        foundStats.push("turnover");
    }
    
    if (query.includes("fantasy") || query.includes("projected")) {
        foundStats.push("fantasy-points");
    }
    
    return foundStats;
}

//searching for opponent (all 300 nba teams are listed) in the query
async function findOpponentInQuery(userQuery, playerName) {
    const query = userQuery.toLowerCase(); //convert to lowercase for easier matching
    
    //array of all 30 teams 
    //name: variations that people might say, offical: standard name
    const teams = [
        { names: ['lakers', 'la lakers', 'los angeles lakers'], official: 'Lakers' },
        { names: ['warriors', 'golden state', 'gsw'], official: 'Warriors' },
        { names: ['celtics', 'boston'], official: 'Celtics' },
        { names: ['heat', 'miami'], official: 'Heat' },
        { names: ['bulls', 'chicago'], official: 'Bulls' },
        { names: ['knicks', 'new york', 'ny knicks'], official: 'Knicks' },
        { names: ['nets', 'brooklyn'], official: 'Nets' },
        { names: ['sixers', '76ers', 'philadelphia'], official: '76ers' },
        { names: ['bucks', 'milwaukee'], official: 'Bucks' },
        { names: ['raptors', 'toronto'], official: 'Raptors' },
        { names: ['cavaliers', 'cavs', 'cleveland'], official: 'Cavaliers' },
        { names: ['pistons', 'detroit'], official: 'Pistons' },
        { names: ['pacers', 'indiana'], official: 'Pacers' },
        { names: ['hawks', 'atlanta'], official: 'Hawks' },
        { names: ['hornets', 'charlotte'], official: 'Hornets' },
        { names: ['magic', 'orlando'], official: 'Magic' },
        { names: ['wizards', 'washington'], official: 'Wizards' },
        { names: ['nuggets', 'denver'], official: 'Nuggets' },
        { names: ['timberwolves', 'wolves', 'minnesota'], official: 'Timberwolves' },
        { names: ['thunder', 'okc', 'oklahoma city'], official: 'Thunder' },
        { names: ['blazers', 'trail blazers', 'portland'], official: 'Trail Blazers' },
        { names: ['jazz', 'utah'], official: 'Jazz' },
        { names: ['suns', 'phoenix'], official: 'Suns' },
        { names: ['kings', 'sacramento'], official: 'Kings' },
        { names: ['mavericks', 'mavs', 'dallas'], official: 'Mavericks' },
        { names: ['rockets', 'houston'], official: 'Rockets' },
        { names: ['grizzlies', 'memphis'], official: 'Grizzlies' },
        { names: ['pelicans', 'new orleans'], official: 'Pelicans' },
        { names: ['spurs', 'san antonio'], official: 'Spurs' },
        { names: ['clippers', 'la clippers', 'los angeles clippers'], official: 'Clippers' }
    ];
    
    //remove the player name from the query to remove any chance of accidentally matching name
    let searchQuery = query.replace(playerName.toLowerCase(), '');
    
    //loop through each team object, loop through all variations, if found, return offical name
    for (const team of teams) {
        for (const teamName of team.names) {
            if (searchQuery.includes(teamName)) {
                return team.official;
            }
        }
    }
    
    //if no team is found, return empty string
    return '';
}

//find player name in the query
async function findPlayerNameInQuery(userQuery) {
    const queryWords = userQuery.split(/\s+/);

    //skip these words to minimize langauge errors
    
    const skipWords = ['how', 'many', 'will', 'have', 'get', 'score', 'what', 
                       'is', 'are', 'the', 'a', 'an', 'points', 'rebounds', 
                       'assists', 'stats', 'for', 'about', 'tell', 'me', 'against',
                       'vs', 'versus', 'playing'];
    
    // split into word and next word
    for (let i = 0; i < queryWords.length - 1; i++) {
        const word = queryWords[i].toLowerCase();
        const nextWord = queryWords[i + 1].toLowerCase();
        
        if (skipWords.includes(word) || skipWords.includes(nextWord)) continue;
        
        let playerName = await tryFindPlayer(queryWords[i] + ' ' + queryWords[i + 1]);
        if (playerName) return playerName;
        
        //try reverse order
        playerName = await tryFindPlayer(queryWords[i + 1] + ' ' + queryWords[i]);
        if (playerName) return playerName;
    }

    //search using one word
    
    for (let i = 0; i < queryWords.length; i++) {
        const word = queryWords[i].toLowerCase();
        
        if (skipWords.includes(word)) continue;
        
        let playerName = await tryFindPlayer(queryWords[i]);
        if (playerName) return playerName;
    }
    
    //if no player found, return empty string
    return '';
}

async function tryFindPlayer(guessedName) {
    if (guessedName.length < 2) return null; //if the guessed name it too short, do not bother searching
    
    //build the URL
    try { 
        const apiUrl = API_BASE_URL + encodeURIComponent(guessedName.toLowerCase());
        const response = await fetch(apiUrl); //using await to make sure we wait for the response before continuing
        
        //check if request failed 
        if (!response.ok) {
            return null;
        }
        
        //convert response from JSON string, to js object
        const data = await response.json();
        
        //if backend found the player, return the name
        if (data.found) {
            return data.player.PlayerName;
        }
    } catch (error) {
        //ex: network error, timeout, etc.
        console.error("API Fetch Error:", error);
    }
    //if this point is reached, no player was found, return null
    return null;
}

//wait for the html page to load
document.addEventListener('DOMContentLoaded', function() {
    let queryInput = document.getElementById('queryInput');
    let queryButton = document.getElementById('queryButton');
    let responseArea = document.getElementById('responseArea');
    let responseText = document.getElementById('responseText');
    let loading = document.getElementById('loading');

    //get the references to the html elements via ids 


    //when the query button is clicked, run the function
    queryButton.addEventListener('click', async function() {
        let userQuery = queryInput.value.trim();
        //grab what the user typed, and remove spaces from beginning and end

        //check if the query is empty
        if (userQuery === '') {
            responseText.textContent = "Please enter a query."; //show error message
            loading.style.display = 'none'; //hide the loading spinner 
            responseArea.classList.remove('has-content'); 
            return; //stop here
        }
        
        //if the query is not empty, show the loading spinner
        loading.style.display = 'block';
        responseText.textContent = ''; //clear any previous results
        responseArea.classList.remove('has-content'); //reset the display

        let parseResult = await parseQuery(userQuery); //this runs all the parsing logic on the user query
        //return the result object with playername, opponent, stats,etc.
        
        console.log('Parse result:', parseResult); //log the result to browser console for possible debugging

        // check if this is a valid comparison, so we found both players
        if (parseResult.isComparison && parseResult.playerName && parseResult.player2Name) {
            try {
                console.log(`Comparing ${parseResult.playerName} vs ${parseResult.player2Name}`);
                
                //this is a fall back if the opponent isn't specified, and the server cannot find the next opponent automatically
                const opponent = parseResult.opponentTeam || 'Lakers';

                //build the url
                const compareUrl = COMPARE_API_URL + 
                                encodeURIComponent(parseResult.playerName) + '/' + 
                                encodeURIComponent(parseResult.player2Name) + '/' +
                                encodeURIComponent(opponent);
                const compareResponse = await fetch(compareUrl); //send http request and wait for response
                const compareData = await compareResponse.json(); //convert json response to js object
                
                console.log('Comparison data:', compareData); //log for debuggin
                
                //if there is a back end error, show the error
                if (compareData.error) {
                    responseText.textContent = `Error: ${compareData.error}`;
                } else {
                    //start building display message
                    let responseMessage = `${compareData.player1.name} vs ${compareData.player2.name}\n\n`;

                    //show each player opponent
                    responseMessage += `${compareData.player1.name} vs ${compareData.player1.opponent}\n`;
                    //only run this code if game data exists
                    if (compareData.player1.gameInfo) {
                        //format the game date
                        const date = new Date(compareData.player1.gameInfo.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                        responseMessage += `${date} | ${compareData.player1.gameInfo.location}\n`;
                    }

                    responseMessage += `\n${compareData.player2.name} vs ${compareData.player2.opponent}\n`;
                    if (compareData.player2.gameInfo) {
                        const date = new Date(compareData.player2.gameInfo.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                        responseMessage += `${date} | ${compareData.player2.gameInfo.location}\n`;
                    }

                    //shows predictions for both players with checkmarks next to projected winners
                    //parseFloat = convert string to decimal number 
                    responseMessage += `\nML PROJECTIONS:\n


                    Points:
                    ${compareData.player1.name}: ${compareData.player1.predictions.points} ${parseFloat(compareData.player1.predictions.points) > parseFloat(compareData.player2.predictions.points) ? '✓' : ''}
                    ${compareData.player2.name}: ${compareData.player2.predictions.points} ${parseFloat(compareData.player2.predictions.points) > parseFloat(compareData.player1.predictions.points) ? '✓' : ''}

                    Rebounds:
                    ${compareData.player1.name}: ${compareData.player1.predictions.rebounds} ${parseFloat(compareData.player1.predictions.rebounds) > parseFloat(compareData.player2.predictions.rebounds) ? '✓' : ''}
                    ${compareData.player2.name}: ${compareData.player2.predictions.rebounds} ${parseFloat(compareData.player2.predictions.rebounds) > parseFloat(compareData.player1.predictions.rebounds) ? '✓' : ''}

                    Assists:
                    ${compareData.player1.name}: ${compareData.player1.predictions.assists} ${parseFloat(compareData.player1.predictions.assists) > parseFloat(compareData.player2.predictions.assists) ? '✓' : ''}
                    ${compareData.player2.name}: ${compareData.player2.predictions.assists} ${parseFloat(compareData.player2.predictions.assists) > parseFloat(compareData.player1.predictions.assists) ? '✓' : ''}

                    Steals:
                    ${compareData.player1.name}: ${compareData.player1.predictions.steals} ${parseFloat(compareData.player1.predictions.steals) > parseFloat(compareData.player2.predictions.steals) ? '✓' : ''}
                    ${compareData.player2.name}: ${compareData.player2.predictions.steals} ${parseFloat(compareData.player2.predictions.steals) > parseFloat(compareData.player1.predictions.steals) ? '✓' : ''}

                    Blocks:
                    ${compareData.player1.name}: ${compareData.player1.predictions.blocks} ${parseFloat(compareData.player1.predictions.blocks) > parseFloat(compareData.player2.predictions.blocks) ? '✓' : ''}
                    ${compareData.player2.name}: ${compareData.player2.predictions.blocks} ${parseFloat(compareData.player2.predictions.blocks) > parseFloat(compareData.player1.predictions.blocks) ? '✓' : ''}

                    RECENT FORM:
                    ${compareData.player1.name}: ${compareData.player1.recentForm.trend}
                    ${compareData.player2.name}: ${compareData.player2.recentForm.trend}

                    PROJECTED FANTASY POINTS:
                    ${compareData.player1.name}: ${compareData.player1.projectedFantasyPoints} ${parseFloat(compareData.player1.projectedFantasyPoints) > parseFloat(compareData.player2.projectedFantasyPoints) ? '✓' : ''}
                    ${compareData.player2.name}: ${compareData.player2.projectedFantasyPoints} ${parseFloat(compareData.player2.projectedFantasyPoints) > parseFloat(compareData.player1.projectedFantasyPoints) ? '✓' : ''}

                    ${compareData.recommendation}
                    Confidence: ${compareData.confidence}

                                        Why?
                    ${compareData.reasons.map(r => `                    • ${r}`).join('\n')}`;//add a bullet point to each reason, and make a single string with line breaks
                
                    responseText.textContent = responseMessage.trim(); //remove extra space at beginning and end
                }
            } catch (error) {
                console.error('Comparison error:', error);
                responseText.textContent = `Error loading comparison: ${error.message}`;
            }
        }
        // single player mode
        // we found a player but not in comparison mode
        else if (parseResult.playerName && parseResult.playerName.length > 0) {
            try {
                console.log('Found player:', parseResult.playerName);
                
                let opponentTeam = parseResult.opponentTeam; //parse opponent name
                let autoDetected = false; //auto find their next game
                let nextGameInfo = null; //game details
                
                // auto detect opponent if not specified
                if (!opponentTeam || opponentTeam.length === 0) {
                    console.log('Auto-detecting next game...');
                    
                    try {
                        const nextGameUrl = NEXT_GAME_API_URL + encodeURIComponent(parseResult.playerName); //build the url
                        const nextGameResponse = await fetch(nextGameUrl); //call api to get next game
                        const nextGameData = await nextGameResponse.json(); 
                        
                        if (nextGameData.found) {
                            opponentTeam = nextGameData.nextGame.opponent; //set the opponent 
                            autoDetected = true; //mark the opponent as auto detected
                            nextGameInfo = nextGameData.nextGame; //save game info 

                            console.log(`✓ Auto-detected: ${nextGameData.team} vs ${opponentTeam}`);
                            console.log(`  Date: ${new Date(nextGameData.nextGame.date).toLocaleDateString()}`);
                            console.log(`  Location: ${nextGameData.nextGame.location}`);
                        } else {
                            console.log('No upcoming games found');
                        }
                    } catch (error) {
                        console.error('Auto-detect error:', error);
                    }
                }

                //only make the prediction if we have an opponent (either use the specified opponent, or the auto detected one)

                if (opponentTeam && opponentTeam.length > 0) {
                    console.log('Making prediction...');
                    //build the url for the python server

                    const predictUrl = PREDICT_API_URL + 
                                    encodeURIComponent(parseResult.playerName) + '/' + 
                                    encodeURIComponent(opponentTeam);

                    const predictResponse = await fetch(predictUrl);
                    const predictData = await predictResponse.json();
                    
                    console.log('Prediction data:', predictData);
                    
                    if (predictData.error) {
                        responseText.textContent = `Error: ${predictData.error}`;
                    } else {
                        let responseMessage = '';

                // building the response message
                //add player name in upper case
                responseMessage += `${predictData.player.toUpperCase()}\n`;

                //if the game was auto detected, show all the details

                if (autoDetected && nextGameInfo) {
                    const gameDate = new Date(nextGameInfo.date).toLocaleDateString('en-US', { 
                        weekday: 'short', 
                        month: 'short', 
                        day: 'numeric' 
                    });
                    const location = nextGameInfo.location === 'Home' ? 'Home' : 'Away';
                    responseMessage += `${gameDate} | ${location} vs ${predictData.opponent}\n\n`;
                } else {
                    responseMessage += `vs ${predictData.opponent}\n\n`;
                }

                //creates boolean (true/false) flags for each stat

                //if user specifies for the specific stat, or if the user doesn't specify any stat (show everything)

                const showPoints = parseResult.statsAskedFor.includes('points') || parseResult.statsAskedFor.length === 0;
                const showRebounds = parseResult.statsAskedFor.includes('rebounds') || parseResult.statsAskedFor.length === 0;
                const showAssists = parseResult.statsAskedFor.includes('assists') || parseResult.statsAskedFor.length === 0;
                const showSteals = parseResult.statsAskedFor.includes('steals') || parseResult.statsAskedFor.length === 0;
                const showBlocks = parseResult.statsAskedFor.includes('blocks') || parseResult.statsAskedFor.length === 0;
                const showTurnovers = parseResult.statsAskedFor.includes('turnovers') || parseResult.statsAskedFor.length === 0;
                const showFantasy = parseResult.statsAskedFor.includes('fantasy-points');

                //show the prediction value
                //show the confidence percentage
                //add spacing

                if (showPoints) {
                    responseMessage += `PROJECTION: ${predictData.predictions.points.value} POINTS\n`;
                    responseMessage += `Confidence: ${predictData.predictions.points.confidence}%\n`;
                    responseMessage += `\n\n`; // 4 newlines for space
                }

                if (showRebounds) {
                    responseMessage += `PROJECTION: ${predictData.predictions.rebounds.value} REBOUNDS\n`;
                    responseMessage += `Confidence: ${predictData.predictions.rebounds.confidence}%\n\n`;
                }

                if (showAssists) {
                    responseMessage += `PROJECTION: ${predictData.predictions.assists.value} ASSISTS\n`;
                    responseMessage += `Confidence: ${predictData.predictions.assists.confidence}%\n\n`;
                }

                if (showSteals) {
                    responseMessage += `PROJECTION: ${predictData.predictions.steals.value} STEALS\n`;
                    responseMessage += `Confidence: ${predictData.predictions.steals.confidence}%\n\n`;
                }

                if (showBlocks) {
                    responseMessage += `PROJECTION: ${predictData.predictions.blocks.value} BLOCKS\n`;
                    responseMessage += `Confidence: ${predictData.predictions.blocks.confidence}%\n\n`;
                }

                if (showTurnovers) {
                    responseMessage += `PROJECTION: ${predictData.predictions.turnovers.value} TURNOVERS\n`;
                    responseMessage += `Confidence: ${predictData.predictions.turnovers.confidence}%\n\n`;
                }

                // show fantasy score when displaying all stats
                if (showPoints && showRebounds && showAssists && showSteals && showBlocks && showTurnovers) {
                    responseMessage += `\nFANTASY SCORE PROJECTION: ${predictData.predictions.fantasyScore.value}\n`;
                    responseMessage += `Confidence: ${predictData.predictions.fantasyScore.confidence}%\n\n`;
                }

                //or show if user asks for it

                if (showFantasy) {
                    responseMessage += `FANTASY SCORE PROJECTION: ${predictData.predictions.fantasyScore.value}\n`;
                    responseMessage += `Confidence: ${predictData.predictions.fantasyScore.confidence}%\n\n`;
                }

                // the data section
                responseMessage += `DATA:\n\n`;

                //season average, last 5 games average, and historical performance vs this opponent (if available)
                if (showPoints) {
                    responseMessage += `Season Average: ${predictData.breakdown.seasonAvgPoints} pts\n`;
                    responseMessage += `Last 5 Games: ${predictData.breakdown.last5AvgPoints} pts\n`;
                    if (predictData.breakdown.vsTeamPoints) {
                        responseMessage += `Since 2022 vs ${predictData.opponent}: ${predictData.breakdown.vsTeamPoints} pts\n`;
                    } else {
                        responseMessage += `Since 2022 vs ${predictData.opponent}: No matchup history\n`;
                    }
                    responseMessage += `\n`;
                }

                if (showRebounds) {
                    responseMessage += `Season Avg Rebounds: ${predictData.breakdown.seasonAvgRebounds}\n`;
                    if (predictData.breakdown.vsTeamRebounds) {
                        responseMessage += `Since 2022 vs ${predictData.opponent}: ${predictData.breakdown.vsTeamRebounds} rebs\n`;
                    } else {
                        responseMessage += `Since 2022 vs ${predictData.opponent}: No matchup history\n`;
                    }
                    responseMessage += `Opponent allows: ${predictData.breakdown.opponentReboundsAllowed} rebs/game\n`;
                    responseMessage += `\n`;
                }

                if (showAssists) {
                    responseMessage += `Season Avg Assists: ${predictData.breakdown.seasonAvgAssists}\n`;
                    if (predictData.breakdown.vsTeamAssists) {
                        responseMessage += `Since 2022 vs ${predictData.opponent}: ${predictData.breakdown.vsTeamAssists} ast\n`;
                    } else {
                        responseMessage += `Since 2022 vs ${predictData.opponent}: No matchup history\n`;
                    }
                    responseMessage += `\n`;
                }

                if (showSteals) {
                    responseMessage += `Season Avg Steals: ${predictData.breakdown.seasonAvgSteals || 'N/A'}\n\n`;
                }

                if (showBlocks) {
                    responseMessage += `Season Avg Blocks: ${predictData.breakdown.seasonAvgBlocks || 'N/A'}\n\n`;
                }

                if (showTurnovers) {
                    responseMessage += `Season Avg Turnovers: ${predictData.breakdown.seasonAvgTurnovers || 'N/A'}\n\n`;
                }



                responseMessage += `Opponent Defense: ${predictData.breakdown.opponentDefense} pts allowed/game\n`;
                responseMessage += `\n\n`; // 4 newlines for space

                // analysis section
                responseMessage += `ANALYSIS:\n\n`;

                const insights = [];

                // recent performance
                if (predictData.breakdown.last5AvgPoints < predictData.breakdown.seasonAvgPoints - 3) {
                    insights.push(`Cold Streak: Recent performance (${predictData.breakdown.last5AvgPoints} pts) below season average (${predictData.breakdown.seasonAvgPoints} pts)`);
                } else if (predictData.breakdown.last5AvgPoints > predictData.breakdown.seasonAvgPoints + 3) {
                    insights.push(`Hot Streak: Recent performance (${predictData.breakdown.last5AvgPoints} pts) above season average (${predictData.breakdown.seasonAvgPoints} pts)`);
                }

                // matchup history
                if (showPoints && predictData.breakdown.vsTeamPoints) {
                    const matchupDiff = predictData.breakdown.vsTeamPoints - predictData.breakdown.seasonAvgPoints;
                    if (matchupDiff > 3) {
                        insights.push(`Strong Matchup: Averages ${predictData.breakdown.vsTeamPoints} pts vs ${predictData.opponent}`);
                    } else if (matchupDiff < -3) {
                        insights.push(`Tough Matchup: Averages ${predictData.breakdown.vsTeamPoints} pts vs ${predictData.opponent}`);
                    }
                }

                if (showRebounds && predictData.breakdown.vsTeamRebounds) {
                    const matchupDiff = predictData.breakdown.vsTeamRebounds - predictData.breakdown.seasonAvgRebounds;
                    if (matchupDiff > 2) {
                        insights.push(`Strong Matchup: Averages ${predictData.breakdown.vsTeamRebounds} rebs vs ${predictData.opponent}`);
                    } else if (matchupDiff < -2) {
                        insights.push(`Tough Matchup: Averages ${predictData.breakdown.vsTeamRebounds} rebs vs ${predictData.opponent}`);
                    }
                }

                if (showAssists && predictData.breakdown.vsTeamAssists) {
                    const matchupDiff = predictData.breakdown.vsTeamAssists - predictData.breakdown.seasonAvgAssists;
                    if (matchupDiff > 1.5) {
                        insights.push(`Strong Matchup: Averages ${predictData.breakdown.vsTeamAssists} ast vs ${predictData.opponent}`);
                    } else if (matchupDiff < -1.5) {
                        insights.push(`Tough Matchup: Averages ${predictData.breakdown.vsTeamAssists} ast vs ${predictData.opponent}`);
                    }
                }

                // defense quality
                if (predictData.breakdown.opponentDefense > 115) {
                    insights.push(`Weak Defense: ${predictData.opponent} allows ${predictData.breakdown.opponentDefense} pts/game`);
                } else if (predictData.breakdown.opponentDefense < 105) {
                    insights.push(`Strong Defense: ${predictData.opponent} allows only ${predictData.breakdown.opponentDefense} pts/game`);
                }

                // confidence
                if (predictData.predictions.points.confidence < 50) {
                    insights.push(`Lower Confidence: Recent inconsistency or limited matchup data`);
                }

                if (insights.length > 0) {
                    insights.forEach(insight => {
                        responseMessage += `• ${insight}\n`;
                    });
                } else {
                    responseMessage += `• Standard projection\n`;
                }

                responseText.textContent = responseMessage.trim();
                    }
                } else {
                    // no opponent found - show basic stats
                    console.log('No opponent found, showing stats...');
                    const statsUrl = STATS_API_URL + encodeURIComponent(parseResult.playerName);
                    const statsResponse = await fetch(statsUrl);
                    const statsData = await statsResponse.json();
                    
                    if (statsData.found) {
                        let responseMessage = `Stats for ${statsData.playerName}\n`;
                        responseMessage += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                        responseMessage += `Based on ${statsData.gamesPlayed} games in ${statsData.season}:\n\n`;
                        responseMessage += `Points: ${statsData.projection.points} avg\n`;
                        responseMessage += `Rebounds: ${statsData.projection.rebounds} avg\n`;
                        responseMessage += `Assists: ${statsData.projection.assists} avg\n`;
                        responseMessage += `Steals: ${statsData.projection.steals} avg\n`;
                        responseMessage += `Blocks: ${statsData.projection.blocks} avg\n`;
                        responseMessage += `3-Pointers: ${statsData.projection.threePointers} avg\n`;
                        responseMessage += `\nRange:\n`;
                        responseMessage += `   Points: ${statsData.range.minPoints}-${statsData.range.maxPoints}\n`;
                        responseMessage += `   Rebounds: ${statsData.range.minRebounds}-${statsData.range.maxRebounds}\n\n`;
                        responseMessage += `No upcoming games found in schedule.\n`;
                        responseMessage += `Try: "How many points will ${parseResult.playerName} score against the Lakers?"`;
                        
                        responseText.textContent = responseMessage;
                    } else {
                        responseText.textContent = `Player found but no stats available for ${parseResult.playerName} in the current season.`;
                    }
                }
            } catch (error) {
                console.error('API error:', error);
                responseText.textContent = `Error loading data: ${error.message}`;
            }
        } else {
            //couldn't find any player name
            let responseMessage = "Couldn't find a player name in your query.\n\n";
            responseText.textContent = responseMessage;
        }
        
        //hide the loading message and show the results
        loading.style.display = 'none';
        responseArea.classList.add('has-content');
    });

    queryInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            queryButton.click(); //submit the query with the enter button
        }
    });
});