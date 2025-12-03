const sql = require('mssql'); // imports mssql library
const axios = require('axios'); // library for making http requests

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

// api key and base url for basketball api
const API_KEY = 'YOUR_API_KEY';
const BASE_URL = 'https://v1.basketball.api-sports.io';

// fetch upcoming game schedule from api and store in database
async function fetchSchedule() {
    let pool;
    
    try {
        // connect to database
        pool = await sql.connect(dbConfig);
        console.log('✓ Connected to database\n');
        
        console.log('Fetching NBA schedule from API...');
        
        // make api request to get all games for 2025-2026 season
        const response = await axios.get(`${BASE_URL}/games`, {
            headers: {
                'x-rapidapi-key': API_KEY,
                'x-rapidapi-host': 'v1.basketball.api-sports.io'
            },
            params: {
                league: '12', // nba league id
                season: '2025-2026',
                timezone: 'America/New_York'
            }
        });
        
        // extract games from response
        const games = response.data.response || [];
        console.log(`Found ${games.length} games\n`);
        
        // counters to track progress
        let insertedCount = 0;
        let skippedCount = 0;
        
        // loop through each game
        for (const game of games) {
            try {
                const gameDate = new Date(game.date);
                const status = game.status.short;
                
                // only process games that haven't been played yet
                if (status === 'NS' || status === 'TBD' || gameDate > new Date()) {
                    // look up home team id from database
                    const homeTeamResult = await pool.request().query(`
                        SELECT Id FROM Teams WHERE APISportsId = ${game.teams.home.id}
                    `);
                    
                    // look up away team id from database
                    const awayTeamResult = await pool.request().query(`
                        SELECT Id FROM Teams WHERE APISportsId = ${game.teams.away.id}
                    `);
                    
                    // only proceed if both teams exist in database
                    if (homeTeamResult.recordset.length > 0 && awayTeamResult.recordset.length > 0) {
                        const homeTeamId = homeTeamResult.recordset[0].Id;
                        const awayTeamId = awayTeamResult.recordset[0].Id;
                        
                        // check if home team entry already exists
                        const existsHome = await pool.request().query(`
                            SELECT Id FROM Schedule 
                            WHERE TeamId = ${homeTeamId} 
                            AND OpponentTeamId = ${awayTeamId}
                            AND CAST(GameDate AS DATE) = '${gameDate.toISOString().split('T')[0]}'
                        `);
                        
                        // insert home team schedule entry if it doesn't exist
                        if (existsHome.recordset.length === 0) {
                            await pool.request().query(`
                                INSERT INTO Schedule (TeamId, OpponentTeamId, GameDate, Season, HomeAway)
                                VALUES (${homeTeamId}, ${awayTeamId}, '${gameDate.toISOString()}', '2025-2026', 'Home')
                            `);
                            insertedCount++;
                        }
                        
                        // check if away team entry already exists
                        const existsAway = await pool.request().query(`
                            SELECT Id FROM Schedule 
                            WHERE TeamId = ${awayTeamId} 
                            AND OpponentTeamId = ${homeTeamId}
                            AND CAST(GameDate AS DATE) = '${gameDate.toISOString().split('T')[0]}'
                        `);
                        
                        // insert away team schedule entry if it doesn't exist
                        if (existsAway.recordset.length === 0) {
                            await pool.request().query(`
                                INSERT INTO Schedule (TeamId, OpponentTeamId, GameDate, Season, HomeAway)
                                VALUES (${awayTeamId}, ${homeTeamId}, '${gameDate.toISOString()}', '2025-2026', 'Away')
                            `);
                            insertedCount++;
                        }
                        
                        // track how many entries were already in database
                        if (existsHome.recordset.length > 0 && existsAway.recordset.length > 0) {
                            skippedCount += 2;
                        }
                        
                        // log progress every 50 inserts
                        if (insertedCount % 50 === 0 && insertedCount > 0) {
                            console.log(`Inserted ${insertedCount} schedule entries...`);
                        }
                    }
                }
                
            } catch (error) {
                console.error(`Error processing game ${game.id}:`, error.message);
            }
        }
        
        // print completion summary
        console.log(`\nSchedule fetch complete!`);
        console.log(`   Inserted: ${insertedCount} entries`);
        console.log(`   Skipped: ${skippedCount} entries`);
        
        // query database for schedule statistics
        const summary = await pool.request().query(`
            SELECT 
                COUNT(*) as TotalEntries,
                COUNT(DISTINCT TeamId) as Teams,
                MIN(GameDate) as FirstGame,
                MAX(GameDate) as LastGame,
                COUNT(CASE WHEN GameDate > GETDATE() THEN 1 END) as UpcomingGames
            FROM Schedule
            WHERE Season = '2025-2026'
        `);
        
        // display schedule statistics
        const stats = summary.recordset[0];
        console.log(`\nSchedule Summary:`);
        console.log(`   Total entries: ${stats.TotalEntries}`);
        console.log(`   Teams: ${stats.Teams}`);
        console.log(`   Upcoming games: ${stats.UpcomingGames}`);
        console.log(`   First game: ${stats.FirstGame}`);
        console.log(`   Last game: ${stats.LastGame}`);
        
    } catch (error) {
        console.error('Error:', error.message);
        console.error(error);
    } finally {
        // always close database connection
        if (pool) {
            await pool.close();
        }
    }
}

// start the schedule fetching process
console.log('\n NBA Schedule Fetcher\n');
fetchSchedule().catch(console.error);