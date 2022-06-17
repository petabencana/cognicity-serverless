/**
 * CogniCity Server /feeds data model
 * @module cards/model
 **/
const { QueryTypes } = require("@sequelize/core");

/**
 * Methods to interact with feeds layers in database
 * @alias module:src/api/partners/model
 * @param {Object} config Server configuration
 * @param {Object} db PG Promise database instance
 * @param {Object} logger Configured Winston logger instance
 * @return {Object} Query methods
 */
const cards = (config, db) => ({
  // Add a new partner
  create: (body) =>
    new Promise((resolve, reject) => {
      // Setup query
      let network_data = body.network_data || "{}";
      let query = `INSERT INTO ${config.TABLE_GRASP_CARDS}
    (username, network, language, received, network_data)
    VALUES (?, ?, ?, ?, '{}') RETURNING card_id`;

      // Execute
      db.query(query, {
        type: QueryTypes.INSERT,
        replacements: [
          body.username,
          body.network,
          body.language,
          false,
          network_data,
        ],
      })
        .then((data) => {
          // Card created, update database log
          let query = `INSERT INTO ${config.TABLE_GRASP_LOG}
                  (card_id, event_type) VALUES (?, ?)`;
          db.query(query, {
            type: QueryTypes.INSERT,
            replacements: [data[0][0].card_id, "CARD CREATED"],
          })
            .then(() => {
              resolve(data[0][0]);
            })
            .catch((err) => {
              reject(err);
            });
        })
        /* istanbul ignore next */
        .catch((err) => {
          /* istanbul ignore next */
          reject(err);
        });
    }),

  // Return specific card by id
  byCardId: (cardId) =>
    new Promise((resolve, reject) => {
      // Setup query
      let query = `SELECT c.card_id, c.username, c.network, c.language,
    c.received, CASE WHEN r.card_id IS NOT NULL THEN
      json_build_object('created_at', r.created_at, 'disaster_type',
      r.disaster_type, 'text', r.text, 'card_data', r.card_data, 'image_url',
      r.image_url, 'status', r.status)
    ELSE null END AS report
    FROM ${config.TABLE_GRASP_CARDS} c
    LEFT JOIN ${config.TABLE_GRASP_REPORTS} r USING (card_id)
    WHERE c.card_id = ?
    LIMIT 1`;

      // Execute
      db.query(query, {
        type: QueryTypes.SELECT,
        replacements: [cardId],
      })
        .then((data) => resolve(...data))
        /* istanbul ignore next */
        .catch((err) => {
          console.log("🚀 ~ file: model.js ~ line 81 ~ newPromise ~ err", err);
          /* istanbul ignore next */
          reject(err);
        });
    }),

  // All just expired report cards
  expiredCards: () =>
    new Promise((resolve, reject) => {
      // eslint-disable-next-line max-len
      let query = `SELECT c.card_id, c.username, c.network, c.language, c.network_data,
    c.received, CASE WHEN r.card_id IS NOT NULL THEN
      json_build_object('created_at', r.created_at, 'disaster_type',
      r.disaster_type, 'text', r.text, 'card_data', r.card_data, 'image_url',
      r.image_url, 'status', r.status)
    ELSE null END AS report
    FROM ${config.TABLE_GRASP_CARDS} c
    LEFT JOIN ${config.TABLE_GRASP_REPORTS} r USING (card_id)
    WHERE ((r.disaster_type = 'flood' AND r.created_at >= to_timestamp(?) AND r.created_at <= to_timestamp(?) )
    OR (r.disaster_type = 'earthquake' AND r.created_at >= to_timestamp(?) AND r.created_at <= to_timestamp(?) )
    OR (r.disaster_type = 'wind' AND r.created_at >= to_timestamp(?) AND r.created_at <= to_timestamp(?) )
    OR (r.disaster_type = 'haze' AND r.created_at >= to_timestamp(?) AND r.created_at <= to_timestamp(?) )
    OR (r.disaster_type = 'volcano' AND r.created_at >= to_timestamp(?) AND r.created_at <= to_timestamp(?) )
    OR (r.disaster_type = 'fire' AND r.created_at >= to_timestamp(?)) AND r.created_at <= to_timestamp(?) )`;
      let now = Date.now() / 1000;
      // Execute
      db.query(query, {
        type: QueryTypes.SELECT,
        replacements: [
          now - config.FLOOD_REPORTS_TIME_WINDOW,
          now - config.FLOOD_REPORTS_TIME_WINDOW + 1800,
          now - config.EQ_REPORTS_TIME_WINDOW,
          now - config.EQ_REPORTS_TIME_WINDOW + 1800,
          now - config.WIND_REPORTS_TIME_WINDOW,
          now - config.WIND_REPORTS_TIME_WINDOW + 1800,
          now - config.HAZE_REPORTS_TIME_WINDOW,
          now - config.HAZE_REPORTS_TIME_WINDOW + 1800,
          now - config.VOLCANO_REPORTS_TIME_WINDOW,
          now - config.VOLCANO_REPORTS_TIME_WINDOW + 1800,
          now - config.FIRE_REPORTS_TIME_WINDOW,
          now - config.FIRE_REPORTS_TIME_WINDOW + 1800,
        ],
      })
        .then((data) => resolve(data))
        /* istanbul ignore next */
        .catch((err) => {
          /* istanbul ignore next */
          reject(err);
        });
    }),

  // Add entry to the reports table and then update the card record accordingly
  submitReport: (card, body) =>
    new Promise((resolve, reject) => {
      let partner_code = !!body.partnerCode ? body.partnerCode : null;

      // Log queries to debugger
      //   for (let query of queries) logger.debug(query.query, query.values);

      // Execute in a transaction as both INSERT and UPDATE must happen together
      let queries = [
        {
          query: `INSERT INTO ${config.TABLE_GRASP_REPORTS}
              (card_id, card_data, text, created_at, disaster_type,
                partner_code, status,
                the_geom)
              VALUES (?, ? , COALESCE(?,null),? , COALESCE(?,null), COALESCE(?,null), ?,
              ST_SetSRID(ST_Point(?,?),4326))`,
          type: QueryTypes.INSERT,
          replacements: [
            card.card_id,
            JSON.stringify(body.card_data),
            body.text,
            body.created_at,
            body.disaster_type,
            partner_code,
            "Confirmed",
            body.location.lng,
            body.location.lat,
          ],
        },
        {
          query: `UPDATE ${config.TABLE_GRASP_CARDS}
              SET received = TRUE WHERE card_id = ?`,
          type: QueryTypes.UPDATE,
          replacements: [card.card_id],
        },
        {
          query: `INSERT INTO ${config.TABLE_GRASP_LOG}
            (card_id, event_type)
            VALUES (?,?)`,
          type: QueryTypes.INSERT,
          replacements: [card.card_id, "REPORT SUBMITTED"],
        },
        {
          query: `SELECT * FROM grasp.push_to_all_reports(?) as notify`,
          type: QueryTypes.SELECT,
          replacements: [card.card_id],
        },
      ];

      // Log queries to debugger
      //   for (let query of queries) logger.debug(query.query, query.values);

      // Execute in a transaction as both INSERT and UPDATE must happen together
      db.transaction(async (transaction) => {
        try {
          for (let query of queries) {
            await db.query(query.query, {
              type: query.type,
              replacements: query.replacements,
              transaction,
            });
          }
        } catch (error) {
          console.log(
            "🚀 ~ file: model.js ~ line 197 ~ db.transaction ~ error",
            error
          );
          reject(error);
          transaction.rollback();
        }
      })
        .then((data) => {
          console.log(
            "🚀 ~ file: model.js ~ line 203 ~ db.transaction ~ data",
            data
          );
          resolve(data);
        })
        .catch((err) => {
          console.log("🚀 ~ file: model.js ~ line 210 ~ newPromise ~ err", err);
          reject(err);
        });
    }),

  // Update the reports table with new report details
  updateReport: (card, body) =>
    new Promise((resolve, reject) => {
      // Setup our queries
      let queries = [
        {
          query: `UPDATE ${config.TABLE_GRASP_REPORTS} SET
        image_url = COALESCE(?, image_url)
        WHERE card_id = ?`,
          values: [card.card_id, body.image_url],
        },
        {
          query: `INSERT INTO ${config.TABLE_GRASP_LOG}
            (card_id, event_type)
            VALUES (?, ?)`,
          values: [card.card_id, "REPORT UPDATE (PATCH)"],
        },
      ];

      // Log queries to debugger
      //   for (let query of queries) logger.debug(query.query, query.values);

      // Execute in a transaction as both INSERT and UPDATE must happen together
      db.transaction(async (transaction) => {
        try {
          for (let query of queries) {
            await db.query(query.query, {
              type: query.type,
              replacements: query.replacements,
              transaction,
            });
          }
        } catch (error) {
          reject(error);
          transaction.rollback();
        }
      })
        .then((data) => {
          resolve(data);
        })
        .catch((err) => {
          reject(err);
        });
    }),

  //   fetchAllPartners: () =>
  //     new Promise((resolve, reject) => {
  //       try {
  //         const users = db.query(
  //           `SELECT * FROM ${config.TABLE_COGNICITY_PARTNERS}`,
  //           {
  //             type: QueryTypes.SELECT,
  //           }
  //         );
  //         resolve(users);
  //       } catch (err) {
  //         console.log("Error here", err);
  //         reject(err);
  //       }
  //     }),

  //   getByCode: (value) =>
  //     new Promise((resolve, reject) => {
  //       // Setup query
  //       let partner_code = value.partner_code;

  //       const users = `SELECT * FROM ${config.TABLE_COGNICITY_PARTNERS}
  //          WHERE partner_code = ?`;

  //       // Execute
  //       db.query(users, {
  //         type: QueryTypes.UPDATE,
  //         replacements: [partner_code],
  //       })
  //         .then((data) => {
  //           resolve(...data);
  //         })
  //         /* istanbul ignore next */
  //         .catch((err) => {
  //           /* istanbul ignore next */
  //           reject(err);
  //         });
  //     }),

  //   updateRecord: (data, param) =>
  //     new Promise((resolve, reject) => {
  //       // Setup query
  //       let partner_name = data.partner_name ? data.partner_name : null;
  //       let partner_code = data.partner_code ? data.partner_code : null;
  //       let partner_status =
  //         data.partner_status !== undefined ? data.partner_status : null;
  //       let partner_icon = data.partner_icon ? data.partner_icon : null;

  //       const query = `UPDATE ${config.TABLE_COGNICITY_PARTNERS}
  //        SET partner_name = COALESCE(?, partner_name)  , partner_code = COALESCE(?, partner_code) , partner_status = COALESCE(?, partner_status) , partner_icon = COALESCE(?, partner_icon)  WHERE id = ${param.id}`;
  //       // Execute
  //       db.query(query, {
  //         type: QueryTypes.UPDATE,
  //         replacements: [
  //           partner_name,
  //           partner_code,
  //           partner_status,
  //           partner_icon,
  //         ],
  //       })
  //         .then(() => {
  //           resolve({ update: true });
  //         })
  //         .catch((err) => {
  //           reject(err);
  //         });
  //     }),
});

module.exports = cards;