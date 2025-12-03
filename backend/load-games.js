// imports mssql library to connect to azure sql database
const sql = require('mssql');
// library for making http requests to the api
const axios = require('axios');

// database configuration
const dbConfig = {
    user: 'YOUR_USERNAME',
    password: 'YOUR_PASSWORD',
    server: 'YOUR_SERVER.database.windows.net',
    database: 'basketball_data',
    port: 1433,
    options: {
        encrypt: true,
        trustServerCertificate: false,
        enableArithAbort: true
    },
    connectionTimeout: 30000,
    requestTimeout: 30000
};

// api credentials
const API_KEY = 'YOUR_API_KEY';
const BASE_URL = 'https://v1.basketball.api-sports.io';

// helper function to log messages with timestamps
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${level}: ${message}`);
}

// main function to load all games for the season
async function loadGamesSchedule() {
    let pool; // database connection variable
    
    try {
        // connect to database
        pool = await sql.connect(dbConfig);
        log('Connected to database');
        
        log('\nFetching 2025-2026 Season Games');
        
        // fetch all games for the season from the api
        const gamesResponse = await axios.get(`${BASE_URL}/games`, {
            headers: {
                'x-rapidapi-key': API_KEY,
                'x-rapidapi-host': 'v1.basketball.api-sports.io'
            },
            params: {
                league: '12', // nba league id
                season: '2025-2026' // season to fetch
            }
        });
        
        // extract games from response
        const apiGames = gamesResponse.data.response || [];
        log(`Found ${apiGames.length} games in API`);
        
        // separate finished and upcoming games
        const finishedGames = apiGames.filter(g => g.status.short === 'FT');
        const upcomingGames = apiGames.filter(g => g.status.short === 'NS');
        
        log(`  ${finishedGames.length} finished (have stats)`);
        log(`  ${upcomingGames.length} upcoming`);
        
        log('\nLoading Games into Database');
        
        // counters for tracking progress
        let gamesAdded = 0;
        let gamesSkipped = 0;
        
        // loop through each game
        for (const game of apiGames) {
            // check if game already exists in database
            const checkResult = await pool.request().query(`
                SELECT Id FROM Games WHERE APISportsId = ${game.id}
            `);
            
            // if game already exists, skip it
            if (checkResult.recordset.length > 0) {
                gamesSkipped++;
                continue;
            }
            
            // extract game details from api response
            const homeTeamName = game.teams.home.name;
            const awayTeamName = game.teams.away.name;
            const gameDate = new Date(game.date);
            const status = game.status.short;
            const scoreHome = game.scores.home.total || 0;
            const scoreAway = game.scores.away.total || 0;
            const venue = game.venue || '';
            
            // insert game into database
            await pool.request().query(`
                INSERT INTO Games (
                    APISportsId, StartTime, HomeTeam, AwayTeam, 
                    Status, ScoreHome, ScoreAway, Venue
                ) VALUES (
                    ${game.id},
                    '${gameDate.toISOString()}',
                    '${homeTeamName.replace(/'/g, "''")}',
                    '${awayTeamName.replace(/'/g, "''")}',
                    '${status}',
                    ${scoreHome},
                    ${scoreAway},
                    '${venue.replace(/'/g, "''")}'
                )
            `);
            
            gamesAdded++;
        }
        
        // log summary
        log(`\nLoad Complete!`);
        log(`   Games added: ${gamesAdded}`);
        log(`   Games already existed: ${gamesSkipped}`);
        
        // check how many finished games are ready for stats to be fetched
        const readyForStats = await pool.request().query(`
            SELECT COUNT(*) as count
            FROM Games g
            WHERE g.Status IN ('FT', 'AOT')
            AND YEAR(g.StartTime) = 2025
            AND MONTH(g.StartTime) >= 10
            AND NOT EXISTS (SELECT 1 FROM Stats s WHERE s.GameId = g.Id)
        `);
        
        log(`\nReady to fetch stats for: ${readyForStats.recordset[0].count} games`);
        
        // if there are games ready, show next step instructions
        if (readyForStats.recordset[0].count > 0) {
            log('\nNext step: Fetch player stats');
            log('   Run: node fetch-current-season-data.js fetch 2025-2026');
        }
        
    } catch (error) {
        // log any errors that occur
        log(`Error: ${error.message}`, 'ERROR');
        console.error(error);
    } finally {
        // always close the database connection
        if (pool) {
            await pool.close();
            log('\nDatabase connection closed');
        }
    }
}

// run the function when script is executed
console.log('\nLoad 2025-2026 Game Schedules\n');
loadGamesSchedule().catch(console.error);
