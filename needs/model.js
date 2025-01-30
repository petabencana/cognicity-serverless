/* eslint-disable camelcase */
'use strict'
/**
 * CogniCity Server /infrastructure data model
 * @module src/api/needs/model
 **/
const { QueryTypes } = require('@sequelize/core')
const { TABLE_COGNICITY_PARTNERS, TABLE_LOGISTICS_GIVER_DETAILS } = require('../config')
/**
 * Methods to get infrastructure layers from database
 * @alias module:src/api/needs/model
 * @param {Object} config Server configuration
 * @param {Object} db PG Promise database instance
 * @return {Object} Query methods
 */

const needs = (config, db) => ({
    // A list of all infrastructure matching a given type
    all: (is_training, admin) =>
        new Promise((resolve, reject) => {
            // Setup query
            const query = `SELECT 
			nr.need_request_id,
			nr.status,
			nr.created_date,
			ST_AsBinary(nr.the_geom),
            COALESCE(SUM(CAST(nr.quantity_requested AS integer)), 0) AS total_quantity_requested,
            ARRAY_AGG(nr.quantity_requested) AS all_quantity_requested,
			ARRAY_AGG(nr.description) AS all_descriptions,
			ARRAY_AGG(DISTINCT nr.item_id) AS all_item_ids,
			COALESCE(SUM(CAST(gd.quantity_satisfied AS integer)), 0) AS total_quantity_satisfied,
            nr.is_training,
            nr.tags
		FROM 
			${config.TABLE_LOGISTICS_NEEDS} nr
		LEFT JOIN 
			${config.TABLE_LOGISTICS_GIVER_DETAILS} gd ON gd.need_id = nr.id
        WHERE nr.status NOT IN ('EXPIRED')
        AND (
            ($1::boolean IS NULL OR nr.is_training = $1)
            AND (
                (nr.is_training = true AND ($1 = true OR $1 IS NULL) AND nr.created_date > now() - INTERVAL '1 hour')
                OR (nr.is_training = false AND ($1 = false OR $1 IS NULL))
            )
        )
        AND ($2::text IS NULL OR tags->>'instance_region_code'=$2::text)
		GROUP BY 
        nr.need_request_id, nr.status, nr.created_date , ST_AsBinary(nr.the_geom), nr.is_training, nr.tags
		ORDER BY nr.created_date DESC;`

            const isTraining = is_training?.toString() ? is_training : null
            const adminType = admin || null
            // Execute
            db.query(query, {
                type: QueryTypes.SELECT,
                bind: [isTraining, adminType],
            })
                .then((data) => {
                    resolve(data)
                })
                /* istanbul ignore next */
                .catch((err) => {
                    /* istanbul ignore next */
                    reject(err)
                })
        }),

    getByNeedId: (value) =>
        new Promise((resolve, reject) => {
            // Setup query
            const query = `SELECT 
			nd.id, 
			nd.item_id, 
			nd.need_request_id, 
			nd.description,
			nd.quantity_requested,
			ST_X(nd.the_geom) AS longitude,
			ST_Y(nd.the_geom) AS latitude,
			COALESCE(SUM(CAST(gd.quantity_satisfied AS integer)), 0) AS total_quantity_satisfied,
            nd.is_training
		FROM 
			${config.TABLE_LOGISTICS_NEEDS} nd
		LEFT JOIN 
			${config.TABLE_LOGISTICS_GIVER_DETAILS} gd
			ON nd.id = gd.need_id 
		WHERE 
			nd.need_request_id = $1
		GROUP BY 
			nd.need_request_id,
			nd.id,
			nd.item_id,
			nd.description,
			nd.quantity_requested,
			ST_X(nd.the_geom),
			ST_Y(nd.the_geom),
            nd.is_training;
		`
            const needRequestId = value?.requestId || null

            // Execute
            db.query(query, {
                type: QueryTypes.SELECT,
                bind: [needRequestId],
            })
                .then((data) => {
                    resolve(data)
                })
                /* istanbul ignore next */
                .catch((err) => {
                    /* istanbul ignore next */
                    reject(err)
                })
        }),

    addNewNeedReport: (reports) => {
        // eslint-disable-next-line no-async-promise-executor
        return new Promise(async (resolve, reject) => {
            let queryForNeedReports = `INSERT INTO ${config.TABLE_LOGISTICS_NEEDS} ("status", "quantity_requested", "item_requested", "need_language", "units", "item_id", "description", "need_request_id",  "the_geom", "is_training")
				VALUES `

            const needValues = []
            const needPlaceholders = []
            let index = 1

            const userId = reports[0].user_id // As it is always one user who would be requesting for multiple items

            for (const report of reports) {
                needValues.push(
                    report.status,
                    report.quantity_requested,
                    report.item_requested,
                    report.need_language,
                    report.units,
                    report.item_id,
                    report.description || null,
                    report.need_request_id,
                    report.lng,
                    report.lat,
                    report.is_training
                )
                needPlaceholders.push(
                    `($${index}, $${index + 1}, $${index + 2}, $${index + 3}, $${index + 4}, $${index + 5}, 
                    COALESCE($${index + 6},null), $${index + 7},ST_SetSRID(ST_Point($${index + 8}, $${index + 9}), 4326), $${index + 10})`
                )
                index += 11 // increment index by 11 for each report object
            }

            queryForNeedReports += `${needPlaceholders.join(', ')} RETURNING id, need_language`

            try {
                const result = await db.query(queryForNeedReports, {
                    type: QueryTypes.INSERT,
                    bind: needValues,
                })

                const insertedRows = result[0]
                const insertedData = insertedRows.map((row) => ({ id: row.id, need_language: row.need_language }))
                // Prepare the query and values for the associations table
                let queryForAssociations = `INSERT INTO ${config.TABLE_LOGISTICS_NEED_ASSOCIATIONS} ("need_id", "user_id" , "need_language") VALUES `
                const associationPlaceholders = []
                const associationValues = []
                let associationIndex = 1
                insertedData.forEach((data) => {
                    associationValues.push(data.id, userId, data.need_language)
                    associationPlaceholders.push(
                        `($${associationIndex}, $${associationIndex + 1}, $${associationIndex + 2})`
                    )
                    associationIndex += 3
                })

                queryForAssociations += associationPlaceholders.join(', ')

                // Insert into need_user_associations table
                await db.query(queryForAssociations, {
                    type: QueryTypes.INSERT,
                    bind: associationValues,
                })

                resolve(result)
            } catch (err) {
                console.log('Data failed to insert in need reports', err)
                reject(err)
            }
        })
    },

    updateNeed: (body, value) =>
        new Promise((resolve, reject) => {
            const status = body?.status || null
            const quantity_requested = body?.quantity_requested || null
            const item_requested = body?.item_requested || null
            const useCurrentDate = body?.current_date === 'current'

            // Initialize base query and parameters array
            let query = `UPDATE ${config.TABLE_LOGISTICS_NEEDS} SET 
              status = COALESCE($1, status), 
              quantity_requested = COALESCE($2, quantity_requested), 
              item_requested = COALESCE($3, item_requested)`

            // Add the current date handling
            if (useCurrentDate) {
                query += ', created_date = CURRENT_DATE'
            } else {
                query += ', created_date = COALESCE($4, created_date)'
            }

            // Add the WHERE clause
            query += ' WHERE id = $5'

            // Initialize parameters array
            const params = [status, quantity_requested, item_requested]
            if (!useCurrentDate) {
                params.push(body?.current_date || null) // Push the current_date only if not using CURRENT_DATE
            }
            params.push(value.id) // Add the id to the parameters

            // Execute the query
            db.query(query, {
                type: QueryTypes.UPDATE,
                bind: params,
            })
                .then((data) => {
                    resolve(data)
                })
                /* istanbul ignore next */
                .catch((err) => {
                    /* istanbul ignore next */
                    reject(err)
                })
        }),

    rescheduleDeliveryDate: (body, value) => {
        return new Promise((resolve, reject) => {
            const DayMap = {
                one: '1 day',
                two: '2 days',
            }
            // Setup query
            const query = `UPDATE ${config.TABLE_LOGISTICS_GIVER_DETAILS}
            SET promised_date = (DATE(promised_date) + INTERVAL '${DayMap[body.interval]}')::date , date_extended = TRUE WHERE need_id = $1 RETURNING promised_date;`
            // Execute
            db.query(query, {
                type: QueryTypes.UPDATE,
                bind: [value.id],
            })
                .then((data) => {
                    resolve(data)
                })
                /* istanbul ignore next */
                .catch((err) => {
                    /* istanbul ignore next */
                    reject(err)
                })
        })
    },

    // eslint-disable-next-line consistent-return
    addGiverReport: (reports) => {
        try {
            // eslint-disable-next-line no-async-promise-executor
            return new Promise(async (resolve, reject) => {
                let queryForGiverDetails = `INSERT INTO ${config.TABLE_LOGISTICS_GIVER_DETAILS} (
					quantity_satisfied,
					item_satisfied,
					promised_date,
					promised_time,
					giver_language,
					need_id,
                    delivery_code,
					giver_id
				)
				VALUES `
                const values = []
                const placeholders = []
                let index = 1

                const giverUserId = reports[0].user_id // As it is always one user who would be requesting for multiple items

                for (const report of reports) {
                    values.push(
                        report.quantity_satisfied,
                        report.item_satisfied,
                        report.promised_date,
                        report.promised_time,
                        report.giver_language,
                        report.need_id,
                        report.delivery_code,
                        giverUserId
                    )
                    placeholders.push(
                        `($${index}, $${index + 1}, $${index + 2}, $${index + 3}, $${index + 4}, $${index + 5} ,$${index + 6}, $${index + 7})`
                    )
                    index += 8 // increment index by 8 for each report object
                }

                queryForGiverDetails += placeholders.join(', ')
                // Execute
                db.query(queryForGiverDetails, {
                    type: QueryTypes.INSERT,
                    bind: values,
                })
                    .then((data) => {
                        resolve(data)
                    })
                    .catch((err) => {
                        console.log('Data failed to insert in need reports', err)
                        reject(err)
                    })
            })
        } catch (err) {
            console.log('Error inserting', err)
        }
    },

    queryUserIdByNeedId: (id) => {
        return new Promise((resolve, reject) => {
            const query = `SELECT * FROM ${config.TABLE_LOGISTICS_NEED_ASSOCIATIONS} WHERE need_id=$1;`
            db.query(query, {
                type: QueryTypes.SELECT,
                bind: [id],
            })
                .then((data) => {
                    resolve(data)
                })
                .catch((err) => {
                    console.log('error here', err)
                    reject(err)
                })
        })
    },

    queryGiverIdByNeedId: (id) => {
        return new Promise((resolve, reject) => {
            const query = `SELECT * FROM ${config.TABLE_LOGISTICS_GIVER_DETAILS} WHERE need_id=$1;`
            db.query(query, {
                type: QueryTypes.SELECT,
                bind: [id],
            })
                .then((data) => {
                    resolve(data)
                })
                .catch((err) => {
                    console.log('error here', err)
                    reject(err)
                })
        })
    },

    getItems: (params) => {
        return new Promise((resolve, reject) => {
            const IntervalMap = {
                today: 'CURRENT_DATE',
                yesterday: "(CURRENT_DATE - INTERVAL '1 day')",
                expired: "(CURRENT_DATE - INTERVAL '2 day')",
            }
            const query = `SELECT 
        gd.giver_id,
        gd.giver_language,
        gd.date_extended,
        ARRAY_AGG(DISTINCT gd.item_satisfied) AS all_items_satisfied,
        ARRAY_AGG(DISTINCT nr.user_id) AS need_user_id,
        ARRAY_AGG(DISTINCT nr.need_id) AS id,
        ARRAY_AGG(DISTINCT nr.need_language) AS need_language
		FROM 
		${config.TABLE_LOGISTICS_GIVER_DETAILS} gd
		LEFT JOIN 
        ${config.TABLE_LOGISTICS_NEED_ASSOCIATIONS} nr ON nr.need_id = gd.need_id
		WHERE DATE(promised_date) = ${IntervalMap[params.interval]}
        GROUP BY gd.giver_id , gd.giver_language,  gd.date_extended;`

            db.query(query, {
                type: QueryTypes.SELECT,
            })
                .then((data) => {
                    resolve(data)
                })
                .catch((err) => {
                    console.log('error here', err)
                    reject(err)
                })
        })
    },

    getExpiredNeeds: (params) => {
        return new Promise((resolve, reject) => {
            const WhereClauseMap = {
                stale: "AND DATE(created_date) = (CURRENT_DATE - INTERVAL '5 day') AND status != 'IN EXPIRY'",
                'message-expired': "AND DATE(updated_at) = (CURRENT_DATE - INTERVAL '3 day') AND status = 'IN EXPIRY'",
            }
            const query = `SELECT 
                ARRAY_AGG(DISTINCT nr.id) AS need_id,
                ARRAY_AGG(DISTINCT na.user_id) AS need_user_id,
                ARRAY_AGG(DISTINCT na.need_language) AS need_language
            FROM 
                ${config.TABLE_LOGISTICS_NEED_ASSOCIATIONS} na
            LEFT JOIN 
                ${config.TABLE_LOGISTICS_NEEDS} nr ON nr.id = na.need_id
            WHERE 
                ${
                    params.interval === 'stale'
                        ? `NOT EXISTS (
                    SELECT 1 
                    FROM ${config.TABLE_LOGISTICS_GIVER_DETAILS} gd
                    WHERE gd.need_id = nr.id
                )`
                        : 'TRUE'
                }
                ${WhereClauseMap[params.interval]};`

            db.query(query, {
                type: QueryTypes.SELECT,
            })
                .then((data) => {
                    const isDataEmpty = data[0] && Object.values(data[0]).every((val) => val === null)
                    resolve(isDataEmpty ? [] : data)
                })
                .catch((err) => {
                    console.log('error here', err)
                    reject(err)
                })
        })
    },

    getDeliveriesByGiverId: (requestQuery) => {
        return new Promise((resolve, reject) => {
            const giverId = `+${requestQuery.giverId}`
            const deliveryCode = `${requestQuery.code}`
            const query = `SELECT * FROM ${config.TABLE_LOGISTICS_GIVER_DETAILS} WHERE giver_id = $1 AND delivery_code = $2;`

            db.query(query, {
                type: QueryTypes.SELECT,
                bind: [giverId, deliveryCode],
            })
                .then((data) => {
                    console.log('🚀 ~ .then ~ data:', data)
                    resolve(data)
                })
                .catch((err) => {
                    console.log('error here', err)
                    reject(err)
                })
        })
    },

    getNeedIdsByUserId: (userId) => {
        return new Promise((resolve, reject) => {
            const query = `SELECT * FROM ${config.TABLE_LOGISTICS_NEED_ASSOCIATIONS} WHERE user_id = $1;`

            db.query(query, {
                type: QueryTypes.SELECT,
                bind: [userId],
            })
                .then((data) => {
                    resolve(data)
                })
                .catch((err) => {
                    console.log('error here', err)
                    reject(err)
                })
        })
    },

    deleteGiverDetailsById: (needId) => {
        return new Promise((resolve, reject) => {
            const query = `DELETE FROM ${config.TABLE_LOGISTICS_GIVER_DETAILS} WHERE need_id = $1;`

            db.query(query, {
                type: QueryTypes.DELETE,
                bind: [needId],
            })
                .then((data) => {
                    resolve(data)
                })
                .catch((err) => {
                    console.log('error here', err)
                    reject(err)
                })
        })
    },

    UpdateTrainingNeed: () => {
        return new Promise((resolve, reject) => {
            const query = `UPDATE ${config.TABLE_LOGISTICS_NEEDS}
            SET status = 'EXPIRED'
            WHERE is_training = true
            AND created_date <= NOW() - INTERVAL '3 hour';`

            db.query(query, {
                type: QueryTypes.UPDATE,
            })
                .then((data) => {
                    resolve(data)
                })
                .catch((err) => {
                    console.log('error here', err)
                    reject(err)
                })
        })
    },
})

module.exports = needs
