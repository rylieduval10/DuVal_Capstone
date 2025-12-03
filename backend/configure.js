//configure.js = generates aggregated stats that the ml model needs for predictions

const sql = require('mssql'); //imports mssql library

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

//constant for the nba season
const SEASON = '2025-2026';

//function declaration
//allows us to see when each step happened, see if something is taking too long
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${level}: ${message}`);
}

//this keeps all aggregation logic organized in one place
class AggregatePopulator {
    constructor() {
        this.pool = null; //shared across all methods
    }

    async connect() {
        try {
            this.pool = await sql.connect(dbConfig); //opens connection to azure database
            log('Database connected');
            return true;
        } catch (err) {
            log(`Database connection failed: ${err.message}`, 'ERROR');
            return false;
        }
    }

    //method to close database connection
    async disconnect() {
        try {
            if (this.pool) {
                await this.pool.close();
                log('Database connection closed');
            }
        } catch (err) {
            log(`Error closing connection: ${err.message}`, 'ERROR');
        }
    }

    //calculates season averages for every player
    async populatePlayerAggregates() {
        log(`\nPopulating PlayerAggregates for ${SEASON}`);
        try {
            //create a request object
            const request = this.pool.request();
            
            //delete old data (start fresh)
            await request.query(`DELETE FROM PlayerAggregates WHERE Season = '${SEASON}'`);
            log(`Cleared existing PlayerAggregates for ${SEASON}`);

            //calculates season averages from the stats table 
            const insertQuery = `
                INSERT INTO PlayerAggregates (
                PlayerApiId, Season, GamesPlayed, AvgPoints, AvgRebounds, 
                AvgAssists, AvgSteals, AvgBlocks, AvgTurnovers, AvgMinutes, AvgFieldGoalPct, LastUpdated
            )
            SELECT 
                s.PlayerApiId,
                s.Season,
                COUNT(DISTINCT s.GameId) AS GamesPlayed,
                AVG(CAST(s.Points AS FLOAT)) AS AvgPoints,
                AVG(CAST(s.TotalRebounds AS FLOAT)) AS AvgRebounds,
                AVG(CAST(s.Assists AS FLOAT)) AS AvgAssists,
                AVG(CAST(s.Steals AS FLOAT)) AS AvgSteals,
                AVG(CAST(s.Blocks AS FLOAT)) AS AvgBlocks,
                AVG(CAST(s.Turnovers AS FLOAT)) AS AvgTurnovers,
                    AVG(
                        CASE 
                            WHEN s.MinutesPlayed IS NOT NULL AND CHARINDEX(':', s.MinutesPlayed) > 0
                            THEN (CAST(SUBSTRING(s.MinutesPlayed, 1, CHARINDEX(':', s.MinutesPlayed) - 1) AS INT) * 60 +
                                 CAST(SUBSTRING(s.MinutesPlayed, CHARINDEX(':', s.MinutesPlayed) + 1, LEN(s.MinutesPlayed)) AS INT)) / 60.0
                            ELSE 0
                        END
                    ) AS AvgMinutes,
                    CASE 
                        WHEN SUM(CAST(s.FieldGoalsAttempted AS FLOAT)) > 0 
                        THEN SUM(CAST(s.FieldGoalsMade AS FLOAT)) * 100.0 / SUM(CAST(s.FieldGoalsAttempted AS FLOAT))
                        ELSE 0.0 
                    END AS AvgFieldGoalPct,
                    GETDATE()
                FROM Stats s
                WHERE s.Season = '${SEASON}'
                GROUP BY s.PlayerApiId, s.Season`;

            //calculate season averages
            //converts minutes from 32:45 to decimal 
            //calculates field goal percentage (makes sure to check attempts to avoid 0)
            
            //run the insert query 
            await request.query(insertQuery);
            log('Basic aggregates populated');

            //get list of all players
            const playersRequest = this.pool.request();
            const players = await playersRequest.query(`SELECT DISTINCT PlayerApiId FROM Stats WHERE Season = '${SEASON}'`);
            
            //loop through each player
            //call function to calculate last5, last10 averages
            //log the progress in console for every 100 players

            log(`Updating recent averages for ${players.recordset.length} players...`);
            for (let i = 0; i < players.recordset.length; i++) {
                await this.updatePlayerRecentAverages(players.recordset[i].PlayerApiId);
                
                if ((i + 1) % 100 === 0) {
                    log(`  Progress: ${i + 1}/${players.recordset.length} players`);
                }
            }

            const count = await this.pool.request().query(`SELECT COUNT(*) as count FROM PlayerAggregates WHERE Season = '${SEASON}'`);
            log(`PlayerAggregates completed: ${count.recordset[0].count} records`);
            return true;
        } catch (error) {
            log(`Error populating PlayerAggregates: ${error.message}`, 'ERROR');
            return false;
        }
    }

    //calculates last5avgpoints and lat5avg for one player
    async updatePlayerRecentAverages(playerApiId) {
        try {
            const request = this.pool.request();
            
            //get players most recent 5 games, newest first
            //then update playerAggregates with the averages from those 5 games
            const last5Query = `
                WITH PlayerRecentGames AS (
                    SELECT TOP 5
                        Points,
                        MinutesPlayed,
                        ROW_NUMBER() OVER (ORDER BY CreatedDate DESC) as rn
                    FROM Stats
                    WHERE PlayerApiId = ${playerApiId} AND Season = '${SEASON}'
                    ORDER BY CreatedDate DESC
                )
                UPDATE PlayerAggregates
                SET Last5AvgPoints = (SELECT AVG(CAST(Points AS FLOAT)) FROM PlayerRecentGames),
                    Last5AvgMinutes = (
                        SELECT AVG(CASE 
                            WHEN MinutesPlayed IS NOT NULL AND CHARINDEX(':', MinutesPlayed) > 0
                            THEN (CAST(SUBSTRING(MinutesPlayed, 1, CHARINDEX(':', MinutesPlayed) - 1) AS INT) * 60 +
                                 CAST(SUBSTRING(MinutesPlayed, CHARINDEX(':', MinutesPlayed) + 1, LEN(MinutesPlayed)) AS INT)) / 60.0
                            ELSE 0
                        END) FROM PlayerRecentGames
                    )
                WHERE PlayerApiId = ${playerApiId} AND Season = '${SEASON}'`;

            await request.query(last5Query);

            //get players most 10 recent games
            //update playerAggregates with averages from those 10 games

            const last10Query = `
                WITH PlayerRecentGames AS (
                    SELECT TOP 10
                        Points,
                        MinutesPlayed,
                        ROW_NUMBER() OVER (ORDER BY CreatedDate DESC) as rn
                    FROM Stats
                    WHERE PlayerApiId = ${playerApiId} AND Season = '${SEASON}'
                    ORDER BY CreatedDate DESC
                )
                UPDATE PlayerAggregates
                SET Last10AvgPoints = (SELECT AVG(CAST(Points AS FLOAT)) FROM PlayerRecentGames),
                    Last10AvgMinutes = (
                        SELECT AVG(CASE 
                            WHEN MinutesPlayed IS NOT NULL AND CHARINDEX(':', MinutesPlayed) > 0
                            THEN (CAST(SUBSTRING(MinutesPlayed, 1, CHARINDEX(':', MinutesPlayed) - 1) AS INT) * 60 +
                                 CAST(SUBSTRING(MinutesPlayed, CHARINDEX(':', MinutesPlayed) + 1, LEN(MinutesPlayed)) AS INT)) / 60.0
                            ELSE 0
                        END) FROM PlayerRecentGames
                    )
                WHERE PlayerApiId = ${playerApiId} AND Season = '${SEASON}'`;

            await request.query(last10Query);

            //calculate sepearte averages for home vs away games
            const homeAwayQuery = `
                UPDATE PlayerAggregates
                SET HomeAvgPoints = (
                    SELECT AVG(CAST(s.Points AS FLOAT))
                    FROM Stats s
                    INNER JOIN Games g ON s.GameId = g.Id
                    INNER JOIN Teams t ON s.TeamId = t.Id
                    WHERE s.PlayerApiId = ${playerApiId} 
                        AND s.Season = '${SEASON}'
                        AND t.TeamName = g.HomeTeam
                ),
                AwayAvgPoints = (
                    SELECT AVG(CAST(s.Points AS FLOAT))
                    FROM Stats s
                    INNER JOIN Games g ON s.GameId = g.Id
                    INNER JOIN Teams t ON s.TeamId = t.Id
                    WHERE s.PlayerApiId = ${playerApiId} 
                        AND s.Season = '${SEASON}'
                        AND t.TeamName = g.AwayTeam
                )
                WHERE PlayerApiId = ${playerApiId} AND Season = '${SEASON}'`;

            //homeAvgPoints, where players team = home
            //awayAvgPoints, where players team = away

            //some players perform better at home 
            await request.query(homeAwayQuery);
        } catch (error) {
            // Continue on error
        }
    }

    //creates team level stats for each game

    async populateTeamGameStats() {
        log(`\nPopulating TeamGameStats for ${SEASON}`);
        try {
            const request = this.pool.request();

            //clear all old data
            
            await request.query(`DELETE FROM TeamGameStats WHERE Season = '${SEASON}'`);
            log('Cleared existing TeamGameStats');

            //get all games that have stats
            const gamesQuery = `
                SELECT DISTINCT g.Id as GameId, g.APISportsId, g.StartTime, g.HomeTeam, g.AwayTeam, 
                       g.ScoreHome, g.ScoreAway
                FROM Games g
                INNER JOIN Stats s ON s.GameId = g.Id
                WHERE s.Season = '${SEASON}'`;

            const gamesResult = await request.query(gamesQuery);
            const games = gamesResult.recordset;
            
            log(`Found ${games.length} games to process`);

            //loop through each game
            for (let i = 0; i < games.length; i++) {
                const game = games[i];
                
                if ((i + 1) % 50 === 0) {
                    log(`  Processing game ${i + 1}/${games.length}`);
                }

                await this.processGameTeamStats(game); //call processGameTeamStats for each one
            }

            //log progress every 50 games
            const count = await this.pool.request().query(`SELECT COUNT(*) as count FROM TeamGameStats WHERE Season = '${SEASON}'`);
            log(`TeamGameStats completed: ${count.recordset[0].count} records`);
            return true;
        } catch (error) {
            log(`Error populating TeamGameStats: ${error.message}`, 'ERROR');
            return false;
        }
    }

    async processGameTeamStats(game) {
        try {
            const request = this.pool.request();

            //look up team ids from team names
            const homeTeamId = await this.getTeamIdByName(game.HomeTeam);
            const awayTeamId = await this.getTeamIdByName(game.AwayTeam);

            //skip if either team is not found
            if (!homeTeamId || !awayTeamId) {
                return;
            }

            //sum up all players stats for the home team in this game
            const homeStatsQuery = `
            INSERT INTO TeamGameStats (
                GameId, TeamId, Season, GameDate, IsHome, Points, 
                FieldGoalPercentage, ThreePointPercentage, Rebounds, Assists, 
                Turnovers, Steals, Blocks, OpponentPoints
            )
            SELECT 
                ${game.GameId}, ${homeTeamId}, '${SEASON}', 
                '${game.StartTime.toISOString().split('T')[0]}', 1,
                ISNULL(SUM(s.Points), 0),
                CASE WHEN SUM(s.FieldGoalsAttempted) > 0 
                     THEN SUM(CAST(s.FieldGoalsMade AS FLOAT)) * 100.0 / SUM(CAST(s.FieldGoalsAttempted AS FLOAT))
                     ELSE 0 END,
                CASE WHEN SUM(s.ThreePointersAttempted) > 0 
                     THEN SUM(CAST(s.ThreePointersMade AS FLOAT)) * 100.0 / SUM(CAST(s.ThreePointersAttempted AS FLOAT))
                     ELSE 0 END,
                ISNULL(SUM(s.TotalRebounds), 0),
                ISNULL(SUM(s.Assists), 0),
                ISNULL(SUM(s.Turnovers), 0),
                ISNULL(SUM(s.Steals), 0),
                ISNULL(SUM(s.Blocks), 0),
                (SELECT ISNULL(SUM(Points), 0) 
                 FROM Stats 
                 WHERE GameId = ${game.GameId} AND TeamId = ${awayTeamId})  
            FROM Stats s
            WHERE s.GameId = ${game.GameId} AND s.TeamId = ${homeTeamId} AND s.Season = '${SEASON}'`;


            //sum all home team players stats 
            //add up all home players points, same for rebounds, assists, etc.
            //opponent points = away teams score

            await request.query(homeStatsQuery);

            //same for away team
            const awayStatsQuery = `
            INSERT INTO TeamGameStats (
                GameId, TeamId, Season, GameDate, IsHome, Points, 
                FieldGoalPercentage, ThreePointPercentage, Rebounds, Assists, 
                Turnovers, Steals, Blocks, OpponentPoints
            )
            SELECT 
                ${game.GameId}, ${awayTeamId}, '${SEASON}', 
                '${game.StartTime.toISOString().split('T')[0]}', 0,
                ISNULL(SUM(s.Points), 0),
                CASE WHEN SUM(s.FieldGoalsAttempted) > 0 
                     THEN SUM(CAST(s.FieldGoalsMade AS FLOAT)) * 100.0 / SUM(CAST(s.FieldGoalsAttempted AS FLOAT))
                     ELSE 0 END,
                CASE WHEN SUM(s.ThreePointersAttempted) > 0 
                     THEN SUM(CAST(s.ThreePointersMade AS FLOAT)) * 100.0 / SUM(CAST(s.ThreePointersAttempted AS FLOAT))
                     ELSE 0 END,
                ISNULL(SUM(s.TotalRebounds), 0),
                ISNULL(SUM(s.Assists), 0),
                ISNULL(SUM(s.Turnovers), 0),
                ISNULL(SUM(s.Steals), 0),
                ISNULL(SUM(s.Blocks), 0),
                (SELECT ISNULL(SUM(Points), 0) 
                 FROM Stats 
                 WHERE GameId = ${game.GameId} AND TeamId = ${homeTeamId})  -- ✅ HOME team (opponent)
            FROM Stats s
            WHERE s.GameId = ${game.GameId} AND s.TeamId = ${awayTeamId} AND s.Season = '${SEASON}'`;


            await request.query(awayStatsQuery);
        } catch (error) {
           
        }
    }

    //calculate how eachp layer performs against each specific opponent 
    async populatePlayerVsTeam() {
        log(`\nPopulating PlayerVsTeam for ${SEASON}`);
        try {
            const request = this.pool.request();
            
            //clear all old data
            await request.query(`DELETE FROM PlayerVsTeam WHERE Season = '${SEASON}'`);
            log('Cleared existing PlayerVsTeam');

            /*
            1. figure out who the opponent is in each game
            2. if players team is home: opponent is away team
            3. if players team is away : opponent is home team
            4. group by player and opponent
            5. create one row for each player-opponent combo
                example: lebron vs Lakers: 28.5 ppg in 5 games
            */
            const insertQuery = `
                INSERT INTO PlayerVsTeam (
                    PlayerApiId, OpponentTeamId, Season, GamesPlayed, 
                    AvgPoints, AvgRebounds, AvgAssists, AvgMinutes, LastUpdated
                )
                SELECT 
                    s.PlayerApiId,
                    T_Opponent.Id AS OpponentTeamId,
                    s.Season,
                    COUNT(DISTINCT s.GameId) AS GamesPlayed,
                    AVG(CAST(s.Points AS FLOAT)) AS AvgPoints,
                    AVG(CAST(s.TotalRebounds AS FLOAT)) AS AvgRebounds,
                    AVG(CAST(s.Assists AS FLOAT)) AS AvgAssists,
                    AVG(
                        CASE 
                            WHEN s.MinutesPlayed IS NOT NULL AND CHARINDEX(':', s.MinutesPlayed) > 0
                            THEN (CAST(SUBSTRING(s.MinutesPlayed, 1, CHARINDEX(':', s.MinutesPlayed) - 1) AS INT) * 60 +
                                 CAST(SUBSTRING(s.MinutesPlayed, CHARINDEX(':', s.MinutesPlayed) + 1, LEN(s.MinutesPlayed)) AS INT)) / 60.0
                            ELSE 0
                        END
                    ) AS AvgMinutes,
                    GETDATE()
                FROM Stats s
                INNER JOIN Games g ON s.GameId = g.Id
                INNER JOIN Teams T_PlayerTeam ON s.TeamId = T_PlayerTeam.Id
                INNER JOIN Teams T_Opponent ON (
                    (T_Opponent.TeamName = g.HomeTeam AND T_Opponent.TeamName <> T_PlayerTeam.TeamName)
                    OR (T_Opponent.TeamName = g.AwayTeam AND T_Opponent.TeamName <> T_PlayerTeam.TeamName)
                )
                WHERE s.Season = '${SEASON}'
                GROUP BY s.PlayerApiId, T_Opponent.Id, s.Season`;

            await request.query(insertQuery);
            
            const count = await this.pool.request().query(`SELECT COUNT(*) as count FROM PlayerVsTeam WHERE Season = '${SEASON}'`);
            log(`PlayerVsTeam completed: ${count.recordset[0].count} records`);
            return true;
        } catch (error) {
            log(`Error populating PlayerVsTeam: ${error.message}`, 'ERROR');
            return false;
        }
    }

    //calculate defensive ratings for each team
    async populateOpponentDefensiveStats() {
        log(`\nPopulating OpponentDefensiveStats for ${SEASON}`);
        try {
            const request = this.pool.request();
            
            await request.query(`DELETE FROM OpponentDefensiveStats WHERE Season = '${SEASON}'`);
            
            //key field: avgpointsallowed: how many points does this team give up per game
            //low number = good defense
            //high number = bad defense 

            const populateQuery = `
            INSERT INTO OpponentDefensiveStats (
                TeamId, Season, GamesPlayed, AvgPointsAllowed, 
                AvgFieldGoalPctAllowed, AvgThreePointPctAllowed, 
                AvgReboundsAllowed, AvgAssistsAllowed, LastUpdated
            )
            SELECT 
                tgs.TeamId,
                tgs.Season,
                COUNT(*) as GamesPlayed,
                AVG(CAST(tgs.OpponentPoints AS FLOAT)) as AvgPointsAllowed,
                0 as AvgFieldGoalPctAllowed,
                0 as AvgThreePointPctAllowed,
                -- Get the OPPONENT's rebounds (not your own)
                AVG(CAST(opponent.Rebounds AS FLOAT)) as AvgReboundsAllowed,
                -- Get the OPPONENT's assists (not your own)
                AVG(CAST(opponent.Assists AS FLOAT)) as AvgAssistsAllowed,
                GETDATE()
            FROM TeamGameStats tgs
            -- Join to get the opponent's stats from the same game
            INNER JOIN TeamGameStats opponent ON tgs.GameId = opponent.GameId 
                AND tgs.TeamId <> opponent.TeamId
            WHERE tgs.Season = '${SEASON}'
            GROUP BY tgs.TeamId, tgs.Season`;


            await request.query(populateQuery);
            
            const count = await this.pool.request().query(`SELECT COUNT(*) as count FROM OpponentDefensiveStats WHERE Season = '${SEASON}'`);
            log(`OpponentDefensiveStats completed: ${count.recordset[0].count} records`);
            return true;
        } catch (error) {
            log(`Error populating OpponentDefensiveStats: ${error.message}`, 'ERROR');
            return false;
        }
    }

    async getTeamIdByName(teamName) {
        try {
            const request = this.pool.request();
            const escapedName = teamName.replace(/'/g, "''");
            const result = await request.query(`
                SELECT Id FROM Teams WHERE TeamName = '${escapedName}'
            `);
            return result.recordset[0] ? result.recordset[0].Id : null;
        } catch (error) {
            return null;
        }
    }

    //orchestrates everything
    /*
    1. connect to database
    2. check if stats exist
    3. run all 4 populate methods 
    4. disconnect
    */
    async runFullPopulation() {
        log(`\nStarting Aggregate Table Population for ${SEASON}\n`);
        
        if (!await this.connect()) {
            return false;
        }

        try {
            const statsCheck = await this.pool.request().query(`
                SELECT COUNT(*) as count FROM Stats WHERE Season = '${SEASON}'
            `);
            
            if (statsCheck.recordset[0].count === 0) {
                log(`No stats found for ${SEASON}`, 'ERROR');
                return false;
            }
            
            log(`✓ Found ${statsCheck.recordset[0].count} stats records for ${SEASON}\n`);

            await this.populatePlayerAggregates();
            await this.populateTeamGameStats();
            await this.populatePlayerVsTeam();
            await this.populateOpponentDefensiveStats();

            log(`\nAll aggregate tables populated for ${SEASON}!`);
            return true;
        } catch (error) {
            log(`Error: ${error.message}`, 'ERROR');
            return false;
        } finally {
            await this.disconnect();
        }
    }
}

//create an instance, and run it
async function main() {
    const populator = new AggregatePopulator();
    await populator.runFullPopulation();
}

main().catch(console.error);
